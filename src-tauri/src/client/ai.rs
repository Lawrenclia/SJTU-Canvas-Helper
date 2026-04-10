use super::{llm::chat, Client};
use crate::{
    error::{AppError, Result},
    model::{
        CanvasVideoSubTitle, File, SubtitleSummaryProgressPayload,
        SubtitleSummaryResult,
    },
    utils::time::format_time,
};
use futures::stream::{self, StreamExt};
use std::path::Path;

const SUBTITLE_CHUNK_MAX_CHARS: usize = 24000;
const SUBTITLE_CHUNK_CONCURRENCY: usize = 2;
const SUBTITLE_FORCE_WRAP_CHARS: usize = 120;

const SUBTITLE_REQUEST_PREVIEW_PREFIX: &str = "你是一名认真负责的大学课程助教。请根据以下课堂视频字幕整理一份适合课后复习的课堂笔记。\n\
输出要求：\n\
1. 只输出 Markdown 正文，不要使用代码块包住全文，也不要输出额外寒暄。\n\
2. 使用一个一级标题，标题写成“课堂笔记”或更贴合内容的标题。\n\
3. 在一级标题后，最先输出一个二级标题 `课堂内容`。\n\
4. `课堂内容` 部分必须按时间顺序整理 5-12 条小片段；每条用项目符号表示，尽量以时间戳开头或结尾，并用内联代码包裹，例如 `- [00:12:34,000] 讲解了卷积的基本直觉与应用场景`。\n\
5. `课堂内容` 的每条都要简短，聚焦该时间段老师讲了什么，不要写成长段。\n\
6. 在 `课堂内容` 之后，再优先包含以下二级标题：课程概览、知识点梳理、课堂通知与任务、待复习问题。\n\
7. 如果课堂里没有提到某类内容，可以省略对应章节，不要编造。\n\
8. 关键结论、通知、作业、签到、小测、考试提醒，要整理成清晰的项目符号。\n\
9. 如果某个知识点或通知能对应到字幕时间，请在该条目末尾补上内联代码时间戳，例如 `[00:12:34,000]`。\n\
10. 保持语言准确、简洁，像学生可以直接保存的课堂笔记。\n\
\n\
以下是字幕：\n";

fn emit_subtitle_summary_progress<F: Fn(SubtitleSummaryProgressPayload) + Send>(
    progress_handler: &F,
    task_id: &str,
    stage: &str,
    processed: u64,
    total: u64,
    message: impl Into<String>,
) {
    progress_handler(SubtitleSummaryProgressPayload {
        uuid: task_id.to_owned(),
        stage: stage.to_owned(),
        processed,
        total,
        message: message.into(),
    });
}

impl Client {
    pub async fn chat<S: Into<String>>(&self, prompt: S) -> Result<String> {
        self.llm_cli.chat(prompt.into()).await
    }

    pub async fn chat_with_configs<S: Into<String>>(
        &self,
        prompt: S,
        configs: &[crate::model::LLMConfig],
    ) -> Result<String> {
        chat::chat_with_configs(configs.to_vec(), prompt.into()).await
    }

    pub async fn list_llm_models(
        &self,
        config: &crate::model::LLMConfig,
    ) -> Result<Vec<String>> {
        chat::list_models(config.clone()).await
    }

    async fn read_file_content(&self, file: &File) -> Result<String> {
        let path = Path::new(&file.display_name);
        let ext = path
            .extension()
            .and_then(|os_str| os_str.to_str())
            .unwrap_or("");
        let resp = self.get_request(&file.url, None::<&str>).await?;
        let data = resp.bytes().await?;
        let text = self.file_parser.parse(data, ext).await?;
        Ok(text)
    }

    pub async fn explain_file(&self, file: &File) -> Result<String> {
        let text = self.read_file_content(file).await?;
        let prompt = format!("你是一个大学课程助教，你的职责是帮助学生解释和总结课程文件的内容。如果文件是关于作业的，请列出得分点、作业提交要求等重要信息。
            请以 `Markdown` 格式输出（不需要用代码块包起来），并控制在 200-300 字。以下是文件的相关信息：
            文件名：{}。
            文件内容：{}",
                file.display_name,
                text
            );
        tracing::info!("Explain Prompt: {}", prompt);
        let resp = self.llm_cli.chat(prompt).await?;
        Ok(resp)
    }

    pub fn compress_subtitle(&self, subtitle: &[CanvasVideoSubTitle]) -> Result<String> {
        let mut result = Vec::new();

        let mut current_sentence = String::new();
        let mut sentence_start_time: Option<u64> = None;

        for item in subtitle {
            if sentence_start_time.is_none() {
                sentence_start_time = Some(item.bg);
            }

            let content = item.res.trim();
            if content.is_empty() {
                continue;
            }
            current_sentence.push_str(content);

            if current_sentence.ends_with('.')
                || current_sentence.ends_with('。')
                || current_sentence.ends_with('!')
                || current_sentence.ends_with('！')
                || current_sentence.ends_with('?')
                || current_sentence.ends_with('？')
                || current_sentence.ends_with(';')
                || current_sentence.ends_with('；')
                || current_sentence.chars().count() >= SUBTITLE_FORCE_WRAP_CHARS
            {
                let start_time = format_time(sentence_start_time.unwrap());
                result.push(format!("[{}] {}", start_time, current_sentence.trim()));

                current_sentence.clear();
                sentence_start_time = None;
            }
        }

        if !current_sentence.is_empty() {
            let start_time = format_time(sentence_start_time.unwrap());
            result.push(format!("[{}] {}", start_time, current_sentence.trim()));
        }

        Ok(result.join("\n"))
    }

    fn split_subtitle_chunks(&self, subtitle: &str, max_chars: usize) -> Vec<String> {
        let mut chunks = Vec::new();
        let mut current = String::new();

        for line in subtitle.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let additional = if current.is_empty() {
                line.len()
            } else {
                line.len() + 1
            };

            if !current.is_empty() && current.len() + additional > max_chars {
                chunks.push(current);
                current = String::new();
            }

            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }

        if !current.is_empty() {
            chunks.push(current);
        }

        chunks
    }

    fn build_subtitle_notes_prompt(&self, subtitle: &str) -> String {
        format!("{SUBTITLE_REQUEST_PREVIEW_PREFIX}{subtitle}")
    }

    fn build_chunk_extraction_prompt(&self, chunk: &str, chunk_index: usize, chunk_count: usize) -> String {
        format!(
            "你正在为一节课整理课堂笔记。下面是第 {}/{} 段字幕，请先提炼这一段的结构化笔记。\n\
输出要求：\n\
1. 只输出 Markdown。\n\
2. 使用三级标题，标题仅限：### 时间片段、### 本段主题、### 知识点、### 课堂通知与任务、### 待确认问题。\n\
3. `### 时间片段` 必须放在最前面，并按时间顺序列出 3-8 条小片段摘要；每条尽量保留时间戳，并用内联代码包裹，如 `- [00:12:34,000] 介绍了牛顿迭代法的基本思路`。\n\
4. 其他部分继续提炼知识点、通知和待确认问题。\n\
5. 每条项目符号尽量保留原文中的时间戳，并用内联代码包裹，如 `[00:12:34,000]`。\n\
6. 不要编造未出现的信息。\n\
\n\
字幕如下：\n\
{chunk}",
            chunk_index + 1,
            chunk_count
        )
    }

    fn build_chunk_merge_prompt(&self, partial_notes: &[String]) -> String {
        format!(
            "你是一名认真负责的大学课程助教。下面是同一节课不同字幕片段提炼出的阶段性笔记，请合并成一份完整的课堂笔记。\n\
输出要求：\n\
1. 只输出 Markdown 正文，不要加代码块。\n\
2. 使用一个一级标题。\n\
3. 在一级标题后，最先输出二级标题 `课堂内容`。\n\
4. `课堂内容` 部分要把各阶段笔记中的时间片段合并去重后，按时间顺序整理成 5-12 条小片段摘要。\n\
5. `课堂内容` 中每条尽量保留内联代码时间戳，例如 `- [00:12:34,000] 说明了傅里叶级数和周期信号之间的关系`。\n\
6. 在 `课堂内容` 之后，再优先包含以下二级标题：课程概览、知识点梳理、课堂通知与任务、待复习问题。\n\
7. 合并重复内容，按知识结构和时间顺序组织。\n\
8. 对有明确时间点的内容，在条目末尾保留内联代码时间戳，例如 `[00:12:34,000]`。\n\
9. 不要编造原始笔记中没有的信息。\n\
\n\
阶段性笔记如下：\n\
{}",
            partial_notes.join("\n\n---\n\n")
        )
    }

    pub async fn get_subtitle_text(&self, canvas_course_id: i64) -> Result<String> {
        let subtitle = &self.get_subtitle(canvas_course_id).await?.before_assembly_list;
        let compressed_subtitle = self.compress_subtitle(subtitle)?;
        if compressed_subtitle.trim().is_empty() {
            return Err(AppError::LLMError("字幕内容为空，暂时无法生成课堂笔记。".to_string()));
        }
        tracing::info!(
            "AI request preview before chunking (course_id={}):\n{}",
            canvas_course_id,
            self.build_subtitle_notes_prompt(&compressed_subtitle)
        );
        tracing::info!(
            "Subtitle content prepared for AI (course_id={}):\n{}",
            canvas_course_id,
            compressed_subtitle
        );
        Ok(compressed_subtitle)
    }

    async fn summarize_subtitle_content(
        &self,
        task_id: &str,
        _canvas_course_id: i64,
        compressed_subtitle: String,
        progress_handler: &(impl Fn(SubtitleSummaryProgressPayload) + Send),
    ) -> Result<SubtitleSummaryResult> {
        emit_subtitle_summary_progress(
            progress_handler,
            task_id,
            "chunking",
            0,
            0,
            "正在分析字幕长度并规划发送方式…",
        );
        let chunks = self.split_subtitle_chunks(&compressed_subtitle, SUBTITLE_CHUNK_MAX_CHARS);
        tracing::info!("subtitle chunk count: {}", chunks.len());

        if chunks.len() <= 1 {
            emit_subtitle_summary_progress(
                progress_handler,
                task_id,
                "summarizing",
                0,
                1,
                "正在发送完整字幕给 AI…",
            );
            let prompt = self.build_subtitle_notes_prompt(&compressed_subtitle);
            tracing::info!("Generate subtitle notes with single prompt");
            tracing::info!("AI prompt (single chunk):\n{}", prompt);
            let response = self.llm_cli.chat_response(prompt).await?;
            tracing::info!("AI response (single chunk):\n{}", response.content);
            if !response.reasoning_content.trim().is_empty() {
                tracing::info!(
                    "AI reasoning (single chunk):\n{}",
                    response.reasoning_content
                );
            }
            emit_subtitle_summary_progress(
                progress_handler,
                task_id,
                "done",
                1,
                1,
                "课堂笔记已生成，正在整理结果…",
            );
            return Ok(SubtitleSummaryResult {
                markdown: response.content,
                reasoning_content: response.reasoning_content,
                subtitle_content: compressed_subtitle,
            });
        }

        let chunk_count = chunks.len();
        let concurrency = chunk_count.min(SUBTITLE_CHUNK_CONCURRENCY).max(1);
        tracing::info!(
            "Generate {} partial subtitle notes with concurrency {}",
            chunk_count,
            concurrency
        );
        let total_steps = chunk_count as u64 + 1;
        emit_subtitle_summary_progress(
            progress_handler,
            task_id,
            "summarizing",
            0,
            total_steps,
            format!("字幕较长，正在分 {} 段发送给 AI…", chunk_count),
        );

        let mut partial_results = stream::iter(chunks.into_iter().enumerate().map(|(index, chunk)| async move {
            let prompt = self.build_chunk_extraction_prompt(&chunk, index, chunk_count);
            tracing::info!("Generate partial subtitle notes for chunk {}", index + 1);
            tracing::info!("AI prompt (chunk {}):\n{}", index + 1, prompt);
            let response = self.llm_cli.chat_response(prompt).await?;
            tracing::info!("AI response (chunk {}):\n{}", index + 1, response.content);
            if !response.reasoning_content.trim().is_empty() {
                tracing::info!(
                    "AI reasoning (chunk {}):\n{}",
                    index + 1,
                    response.reasoning_content
                );
            }
            Ok::<_, AppError>((index, response))
        }))
        .buffer_unordered(concurrency);

        let mut partial_notes = vec![String::new(); chunk_count];
        let mut partial_reasonings = vec![String::new(); chunk_count];
        let mut completed_chunks = 0_u64;
        while let Some(result) = partial_results.next().await {
            let (index, response) = result?;
            partial_notes[index] = response.content;
            if !response.reasoning_content.trim().is_empty() {
                partial_reasonings[index] = format!(
                    "## 分段 {} 思考内容\n\n{}",
                    index + 1,
                    response.reasoning_content.trim()
                );
            }
            completed_chunks += 1;
            emit_subtitle_summary_progress(
                progress_handler,
                task_id,
                "summarizing",
                completed_chunks,
                total_steps,
                format!("已完成 {}/{} 段字幕总结…", completed_chunks, chunk_count),
            );
        }

        emit_subtitle_summary_progress(
            progress_handler,
            task_id,
            "merging",
            chunk_count as u64,
            total_steps,
            "分段总结完成，正在合并最终课堂笔记…",
        );
        let merge_prompt = self.build_chunk_merge_prompt(&partial_notes);
        tracing::info!("Merge {} partial subtitle notes", partial_notes.len());
        tracing::info!("AI prompt (merge):\n{}", merge_prompt);
        let merged_response = self.llm_cli.chat_response(merge_prompt).await?;
        tracing::info!("AI response (merge):\n{}", merged_response.content);
        if !merged_response.reasoning_content.trim().is_empty() {
            tracing::info!(
                "AI reasoning (merge):\n{}",
                merged_response.reasoning_content
            );
        }
        emit_subtitle_summary_progress(
            progress_handler,
            task_id,
            "done",
            total_steps,
            total_steps,
            "课堂笔记已生成，正在整理结果…",
        );

        Ok(SubtitleSummaryResult {
            markdown: merged_response.content,
            reasoning_content: partial_reasonings
                .into_iter()
                .filter(|item| !item.trim().is_empty())
                .chain(
                    (!merged_response.reasoning_content.trim().is_empty()).then(|| {
                        format!(
                            "## 最终合并思考内容\n\n{}",
                            merged_response.reasoning_content.trim()
                        )
                    }),
                )
                .collect::<Vec<_>>()
                .join("\n\n---\n\n"),
            subtitle_content: compressed_subtitle,
        })
    }

    pub async fn summarize_subtitle(
        &self,
        task_id: &str,
        canvas_course_id: i64,
        subtitle_content: Option<String>,
        progress_handler: impl Fn(SubtitleSummaryProgressPayload) + Send,
    ) -> Result<SubtitleSummaryResult> {
        let compressed_subtitle = if let Some(value) =
            subtitle_content.filter(|value| !value.trim().is_empty())
        {
            emit_subtitle_summary_progress(
                &progress_handler,
                task_id,
                "preparing",
                0,
                0,
                "字幕已准备完成，正在发送给 AI…",
            );
            value
        } else {
            emit_subtitle_summary_progress(
                &progress_handler,
                task_id,
                "preparing",
                0,
                0,
                "正在获取并整理字幕…",
            );
            let value = self.get_subtitle_text(canvas_course_id).await?;
            emit_subtitle_summary_progress(
                &progress_handler,
                task_id,
                "preparing",
                0,
                0,
                "字幕已准备完成，正在发送给 AI…",
            );
            value
        };
        self
            .summarize_subtitle_content(
                task_id,
                canvas_course_id,
                compressed_subtitle,
                &progress_handler,
            )
            .await
    }
}
