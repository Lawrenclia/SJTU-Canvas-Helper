import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save } from "@tauri-apps/plugin-dialog";
import ClosedCaptionRoundedIcon from "@mui/icons-material/ClosedCaptionRounded";
import PictureAsPdfRoundedIcon from "@mui/icons-material/PictureAsPdfRounded";
import PsychologyRoundedIcon from "@mui/icons-material/PsychologyRounded";
import SwapHorizRoundedIcon from "@mui/icons-material/SwapHorizRounded";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Slider,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useEffect, useRef, useState } from "react";
import type { DraggableData, DraggableEvent } from "react-draggable";
import Draggable from "react-draggable";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link as RouterLink } from "react-router-dom";

import ClosableAlert from "../components/closable_alert";
import CourseSelect from "../components/course_select";
import BasicLayout from "../components/layout";
import PPTDownloadTable from "../components/ppt_download_table";
import VideoAggregator from "../components/video_aggregator";
import VideoDownloadTable from "../components/video_download_table";
import videoStyles from "../css/video_player.module.css";
import { getConfig, saveConfig } from "../lib/config";
import { VIDEO_PAGE_HINT_ALERT_KEY } from "../lib/constants";
import { useCourses } from "../lib/hooks";
import { useAppMessage } from "../lib/message";
import {
  CanvasVideo,
  DownloadTask,
  LLMConfig,
  LOG_LEVEL_ERROR,
  SubtitleSummaryCompletedPayload,
  SubtitleSummaryFailedPayload,
  SubtitleSummaryProgressPayload,
  SubtitleSummaryResult,
  VideoDownloadTask,
  VideoInfo,
  VideoPlayInfo,
} from "../lib/model";
import { consoleLog, srtToVtt } from "../lib/utils";

const surfaceCardSx = {
  borderRadius: "28px",
  border: "1px solid",
  borderColor: "divider",
  boxShadow: "0 24px 60px rgba(15, 23, 42, 0.08)",
  backgroundImage: "none",
};

const appWindow = getCurrentWebviewWindow();

const VIDEO_SELECTED_COURSE_STORAGE_KEY = "video_page_selected_course_id";
const VIDEO_SELECTED_VIDEO_STORAGE_KEY = "video_page_selected_video_id";

function buildVideoSummaryCacheKey(videoId?: string, courseId?: number): string {
  if (!videoId) {
    return "";
  }
  if (courseId && courseId > 0) {
    return `${courseId}:${videoId}`;
  }
  return videoId;
}

function buildSummaryPreview(markdown: string, maxLength = 260): string {
  const plainText = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_>-]/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!plainText) {
    return "";
  }

  if (plainText.length <= maxLength) {
    return plainText;
  }

  return `${plainText.slice(0, maxLength).trim()}...`;
}

function buildSummaryRequestPreview(subtitle: string): string {
  const trimmed = subtitle.trim();
  if (!trimmed) {
    return "";
  }

  return `你是一名认真负责的大学课程助教。请根据以下课堂视频字幕整理一份适合课后复习的课堂笔记。
输出要求：
1. 只输出 Markdown 正文，不要使用代码块包住全文，也不要输出额外寒暄。
2. 使用一个一级标题，标题写成“课堂笔记”或更贴合内容的标题。
3. 在一级标题后，最先输出一个二级标题 \`课堂内容\`。
4. \`课堂内容\` 部分必须按时间顺序整理 5-12 条小片段；每条用项目符号表示，尽量以时间戳开头或结尾，并用内联代码包裹。
5. \`课堂内容\` 的每条都要简短，聚焦该时间段老师讲了什么，不要写成长段。
6. 在 \`课堂内容\` 之后，再优先包含以下二级标题：课程概览、知识点梳理、课堂通知与任务、待复习问题。
7. 如果课堂里没有提到某类内容，可以省略对应章节，不要编造。
8. 关键结论、通知、作业、签到、小测、考试提醒，要整理成清晰的项目符号。
9. 如果某个知识点或通知能对应到字幕时间，请在该条目末尾补上内联代码时间戳。
10. 保持语言准确、简洁，像学生可以直接保存的课堂笔记。

以下是字幕：
  ${trimmed}`;
}

function createPendingSummaryProgress(
  taskId: string,
  message: string
): SubtitleSummaryProgressPayload {
  return {
    uuid: taskId,
    stage: "queued",
    processed: 0,
    total: 0,
    message,
  };
}

function timestampToSeconds(timestamp: string): number {
  const match = timestamp.match(/^\[(\d{2}):(\d{2}):(\d{2}),(\d{1,3})\]$/);
  if (!match) {
    return 0;
  }

  const [, hh, mm, ss] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

function normalizeMarkdownCode(children: unknown): string {
  if (Array.isArray(children)) {
    return children.map((item) => String(item ?? "")).join("");
  }
  return String(children ?? "");
}

function hasEnabledLLMConfig(configs?: LLMConfig[], legacyApiKey?: string): boolean {
  if (configs && configs.some((item) => item.enabled && item.api_key.trim())) {
    return true;
  }
  return Boolean(legacyApiKey?.trim());
}

function readStoredNumber(key: string): number | null {
  const value = window.localStorage.getItem(key);
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function VideoPage() {
  const theme = useTheme();
  const [videoDownloadTasks, setVideoDownloadTasks] = useState<VideoDownloadTask[]>([]);
  const [pptDownloadTasks, setPPTDownloadTasks] = useState<DownloadTask[]>([]);
  const [operating, setOperating] = useState(false);
  const courses = useCourses();
  const [messageApi, contextHolder] = useAppMessage();
  const [plays, setPlays] = useState<VideoPlayInfo[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<CanvasVideo | undefined>();
  const [selectedCourseId, setSelectedCourseId] = useState<number>(-1);
  const [videos, setVideos] = useState<CanvasVideo[]>([]);
  const [notLogin, setNotLogin] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [playURLs, setPlayURLs] = useState<string[]>([]);
  const [mainPlayURL, setMainPlayURL] = useState("");
  const [mutedPlayURL, setMutedPlayURL] = useState("");
  const [syncPlay, setSyncPlay] = useState(true);
  const [subVideoSize, setSubVideoSize] = useState<number>(25);
  const [subVideoOpacity, setSubVideoOpacity] = useState(0.8);
  const [subVideoPos, setSubVideoPos] = useState({ x: 100, y: 100 });
  const [subtitleUrl, setSubtitleUrl] = useState<string | undefined>(undefined);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryContent, setSummaryContent] = useState("");
  const [summarySubtitleContent, setSummarySubtitleContent] = useState("");
  const [summaryTaskProgressMap, setSummaryTaskProgressMap] = useState<
    Record<string, SubtitleSummaryProgressPayload>
  >({});
  const [showLoginRequiredDialog, setShowLoginRequiredDialog] = useState(false);
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const subVideoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const firstPlay = useRef(true);
  const restoredCourseRef = useRef(false);
  const restoredVideoForCourseRef = useRef<number | null>(null);
  const currentSummaryTaskKeyRef = useRef("");

  const applySummaryResult = (summary?: SubtitleSummaryResult | null) => {
    setSummaryContent(summary?.markdown ?? "");
    setSummarySubtitleContent(summary?.subtitle_content ?? "");
  };

  const upsertSummaryTaskProgress = (payload: SubtitleSummaryProgressPayload) => {
    setSummaryTaskProgressMap((previous) => ({
      ...previous,
      [payload.uuid]: payload,
    }));
  };

  const removeSummaryTaskProgress = (taskId: string) => {
    setSummaryTaskProgressMap((previous) => {
      if (!previous[taskId]) {
        return previous;
      }
      const next = { ...previous };
      delete next[taskId];
      return next;
    });
  };

  const LinkRenderer = (props: any) => {
    const label = normalizeMarkdownCode(props.children).trim();
    const isTimestamp = /^\[\d{2}:\d{2}:\d{2},\d{1,3}\]$/.test(label);

    if (!isTimestamp) {
      return <code>{props.children}</code>;
    }

    return (
      <Box
        component="button"
        type="button"
        onClick={() => handleMainVideoJump(timestampToSeconds(label))}
        sx={{
          border: "none",
          px: 0.75,
          py: 0.2,
          borderRadius: 1,
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: "0.9em",
          color: "primary.main",
          backgroundColor: alpha(theme.palette.primary.main, 0.1),
        }}
      >
        {label}
      </Box>
    );
  };

  useEffect(() => {
    const unlistenProgress = appWindow.listen<SubtitleSummaryProgressPayload>(
      "subtitle_summary://progress",
      ({ payload }) => {
        upsertSummaryTaskProgress(payload);
      }
    );

    const unlistenCompleted = appWindow.listen<SubtitleSummaryCompletedPayload>(
      "subtitle_summary://completed",
      ({ payload }) => {
        removeSummaryTaskProgress(payload.uuid);
        if (currentSummaryTaskKeyRef.current === payload.uuid) {
          applySummaryResult(payload.summary);
        }
        if (payload.saved_to_cache) {
          messageApi.success(
            `${payload.video_name || "当前视频"} 课堂笔记已生成，已保存到本地`,
            0.8
          );
          return;
        }
        messageApi.warning(
          payload.message ||
            `${payload.video_name || "当前视频"} 课堂笔记已生成，但保存到本地失败`
        );
      }
    );

    const unlistenFailed = appWindow.listen<SubtitleSummaryFailedPayload>(
      "subtitle_summary://failed",
      ({ payload }) => {
        removeSummaryTaskProgress(payload.uuid);
        messageApi.error(
          `${payload.video_name || "当前视频"} 课堂笔记生成失败：${payload.error}`
        );
      }
    );

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenCompleted.then((fn) => fn());
      unlistenFailed.then((fn) => fn());
    };
  }, [messageApi]);

  const handleLoginWebsite = async () => {
    try {
      await invoke("login_canvas_website");
      return true;
    } catch (error) {
      consoleLog(LOG_LEVEL_ERROR, error);
      return false;
    }
  };

  useEffect(() => {
    void loginAndCheck();
    return () => {
      if (!firstPlay.current) {
        void invoke("stop_proxy");
      }
    };
  }, []);

  useEffect(() => {
    if (loaded && notLogin) {
      setShowLoginRequiredDialog(true);
    }
  }, [loaded, notLogin]);

  const loginAndCheck = async (retry = false) => {
    const config = await getConfig(true);
    const success = await handleLoginWebsite();
    if (!success) {
      config.ja_auth_cookie = "";
      await saveConfig(config);
    } else if (!retry) {
      messageApi.success("检测到登录会话，登录成功", 0.5);
    } else {
      messageApi.success("登录成功", 0.5);
    }
    setNotLogin(!success);
    setLoaded(true);
    return success;
  };

  const handleSelectCourse = async (
    selected: number,
    options?: {
      resetStoredVideo?: boolean;
    }
  ) => {
    setOperating(true);
    setSelectedCourseId(selected);
    setVideos([]);
    setSelectedVideo(undefined);
    setPlayURLs([]);
    setPlays([]);
    setMainPlayURL("");
    setMutedPlayURL("");
    restoredVideoForCourseRef.current = null;
    window.localStorage.setItem(VIDEO_SELECTED_COURSE_STORAGE_KEY, `${selected}`);
    if (options?.resetStoredVideo ?? true) {
      window.localStorage.removeItem(VIDEO_SELECTED_VIDEO_STORAGE_KEY);
    }
    await handleGetVideos(selected);
    setOperating(false);
  };

  const handleGetVideoInfo = async (video: CanvasVideo) => {
    try {
      const videoInfo = (await invoke("get_canvas_video_info", {
        videoId: video.videoId,
      })) as VideoInfo;
      const nextPlays = videoInfo.videoPlayResponseVoList;
      nextPlays.forEach((play, index) => {
        play.key = play.id;
        play.index = index;
        const part = index === 0 ? "" : `_录屏`;
        const suffix = index > 2 ? `_${index}.mp4` : ".mp4";
        play.name = `${video.videoName}${part}${suffix}`;
      });
      setPlays(nextPlays);
    } catch (error) {
      messageApi.error(`获取视频信息时出现错误：${error}`);
    }
  };

  const handleSelectVideo = async (selected: string) => {
    const video = videos.find((item) => item.videoId === selected);
    if (video) {
      setPlays([]);
      setPlayURLs([]);
      setMainPlayURL("");
      setMutedPlayURL("");
      setSelectedVideo(video);
      window.localStorage.setItem(VIDEO_SELECTED_VIDEO_STORAGE_KEY, video.videoId);
      await handleGetVideoInfo(video);
    }
  };

  const handleGetVideos = async (courseId: number) => {
    try {
      const nextVideos = (await invoke("get_canvas_videos", {
        courseId,
      })) as CanvasVideo[];
      setVideos(nextVideos);
    } catch (error) {
      messageApi.error(`获取录像时发生了错误：${error}`);
    }
  };

  const handleDownloadVideo = (video: VideoPlayInfo) => {
    const videoId = `${video.id}`;
    if (!videoDownloadTasks.find((task) => task.key === videoId)) {
      setVideoDownloadTasks((tasks) => [
        ...tasks,
        {
          key: videoId,
          video,
          video_name: video.name,
          progress: 0,
          state: "downloading",
        } as VideoDownloadTask,
      ]);
    } else {
      messageApi.warning("请勿重复添加任务");
    }
  };

  const handleDownloadSubtitle = async () => {
    if (!selectedVideo) {
      messageApi.warning("请先选择一个视频");
      return;
    }
    try {
      const outputPath = await save({
        defaultPath: `${selectedVideo.videoName}.srt`,
        filters: [{ name: "Subtitle", extensions: ["srt"] }],
      });
      if (!outputPath) {
        return;
      }
      const videoInfo = (await invoke("get_canvas_video_info", {
        videoId: selectedVideo.videoId,
      })) as VideoInfo;
      await invoke("download_subtitle", {
        canvasCourseId: videoInfo.courId,
        savePath: outputPath,
      });
      messageApi.success("字幕下载成功", 0.5);
    } catch (error) {
      messageApi.error(`下载字幕时发生错误：${error}`);
    }
  };

  const handleSummarizeSubtitle = async (forceRegenerate = false) => {
    if (!selectedVideo) {
      messageApi.warning("请先选择一个视频");
      return;
    }

    const config = await getConfig();
    if (!hasEnabledLLMConfig(config.llm_configs, config.llm_api_key)) {
      messageApi.warning("请先前往设置页配置至少一个启用的 LLM 节点。");
      return;
    }

    const currentVideo = selectedVideo;
    const currentCourseId = selectedCourseId;
    const cacheKey = buildVideoSummaryCacheKey(
      currentVideo.videoId,
      currentCourseId
    );
    if (!cacheKey) {
      messageApi.error("当前视频缺少可用的课堂笔记任务标识。");
      return;
    }

    upsertSummaryTaskProgress(
      createPendingSummaryProgress(
        cacheKey,
        forceRegenerate
          ? "已重新发送给 AI，正在后台生成课堂笔记…"
          : "已发送给 AI，正在后台生成课堂笔记…"
      )
    );

    try {
      const videoInfo = (await invoke("get_canvas_video_info", {
        videoId: currentVideo.videoId,
      })) as VideoInfo;
      const started = (await invoke("start_subtitle_summary", {
        canvasCourseId: videoInfo.courId,
        cacheKey,
        videoName: currentVideo.videoName,
      })) as boolean;

      if (started) {
        return;
      }

      upsertSummaryTaskProgress(
        createPendingSummaryProgress(
          cacheKey,
          "这个视频的课堂笔记已经在后台生成中了…"
        )
      );
    } catch (error) {
      removeSummaryTaskProgress(cacheKey);
      messageApi.error(`启动课堂笔记后台任务时发生错误：${error}`);
    }
  };

  const handleSaveSummary = async () => {
    if (!summaryContent.trim()) {
      messageApi.warning("当前没有可导出的课堂笔记内容。");
      return;
    }

    const safeVideoName = (selectedVideo?.videoName || "课堂笔记").replace(
      /[\\\\/:*?"<>|]/g,
      "_"
    );
    const outputPath = await save({
      defaultPath: `${safeVideoName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });

    if (!outputPath) {
      return;
    }

    await invoke("save_path_file", {
      path: outputPath,
      content: Array.from(new TextEncoder().encode(summaryContent)),
    });
    messageApi.success("课堂笔记已导出", 0.5);
  };

  const handleDownloadPPT = async (videoId: string, saveName: string) => {
    const videoInfo = (await invoke("get_canvas_video_info", { videoId })) as VideoInfo;
    const courseId = videoInfo.courId;
    const outputPath = await save({
      defaultPath: saveName,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (!outputPath) {
      return;
    }

    const displayName = outputPath.split(/[/\\\\]/).pop() || saveName;
    const taskKey = `ppt_${outputPath}`;

    if (!pptDownloadTasks.find((task) => task.key === taskKey)) {
      setPPTDownloadTasks((tasks) => [
        ...tasks,
        {
          key: taskKey,
          name: displayName,
          outputPath,
          progress: 0,
          state: "downloading",
        } as DownloadTask,
      ]);

      void invoke("download_ppt", { courseId, savePath: outputPath })
        .then(() => {
          setPPTDownloadTasks((tasks) =>
            tasks.map((task) =>
              task.key === taskKey
                ? { ...task, state: "completed", progress: 100 }
                : task
            )
          );
          messageApi.success("PPT 下载成功", 0.5);
        })
        .catch((error) => {
          setPPTDownloadTasks((tasks) =>
            tasks.map((task) =>
              task.key === taskKey ? { ...task, state: "fail" } : task
            )
          );
          messageApi.error(`下载 PPT 时发生错误：${error}`);
        });
    } else {
      messageApi.warning("请勿重复添加任务");
    }
  };

  const handleRemoveTask = async (taskToRemove: VideoDownloadTask) => {
    setVideoDownloadTasks((tasks) =>
      tasks.filter((task) => task.key !== taskToRemove.key)
    );
    try {
      await invoke("delete_file_with_name", { name: taskToRemove.video.name });
    } catch (error) {
      if (taskToRemove.state !== "fail") {
        messageApi.error(error as string);
      }
    }
  };

  const handleRemovePPTTask = async (taskToRemove: DownloadTask) => {
    setPPTDownloadTasks((tasks) =>
      tasks.filter((task) => task.key !== taskToRemove.key)
    );
    try {
      if (taskToRemove.outputPath) {
        await invoke("delete_path_file", { path: taskToRemove.outputPath });
      } else {
        await invoke("delete_file_with_name", { name: taskToRemove.name });
      }
    } catch (error) {
      if (taskToRemove.state !== "fail") {
        messageApi.error(error as string);
      }
    }
  };

  const getVidePlayURL = (play: VideoPlayInfo, proxyPort: number) =>
    play.rtmpUrlHdv.replace(
      "https://live.sjtu.edu.cn",
      `http://localhost:${proxyPort}`
    );

  const checkOrStartProxy = async () => {
    if (firstPlay.current) {
      messageApi.open({
        key: "proxy_preparing",
        type: "loading",
        content: "正在启动反向代理...",
        duration: 0,
      });
      let succeed;
      try {
        succeed = (await invoke("prepare_proxy")) as boolean;
      } catch (error) {
        messageApi.error(`反向代理启动失败：${error}`);
      }
      if (succeed) {
        messageApi.destroy("proxy_preparing");
        messageApi.success("反向代理启动成功", 0.5);
      } else {
        messageApi.error("反向代理启动超时");
        void invoke("stop_proxy");
      }
      firstPlay.current = false;
    }
  };

  const handlePlay = async (play: VideoPlayInfo) => {
    const config = await getConfig();
    const playURL = getVidePlayURL(play, config.proxy_port);
    if (playURL === mainPlayURL || playURL === mutedPlayURL) {
      messageApi.warning("已经在播放啦");
      return;
    }
    if (mainPlayURL && mutedPlayURL) {
      messageApi.error("目前只支持双屏观看");
      return;
    }
    await checkOrStartProxy();

    if (!mainPlayURL) {
      setMainPlayURL(playURL);
      setMutedPlayURL("");
      setPlayURLs([playURL]);
      return;
    }

    if (!mutedPlayURL) {
      if (play.index === 0) {
        setMutedPlayURL(mainPlayURL);
        setMainPlayURL(playURL);
        setPlayURLs([playURL, mainPlayURL]);
      } else {
        setMutedPlayURL(playURL);
        setPlayURLs([mainPlayURL, playURL]);
      }
      return;
    }

    if (play.index !== 0 || playURL !== mainPlayURL) {
      setMutedPlayURL(playURL);
    }
    setPlayURLs((urls) => [...urls, playURL]);
  };

  const handleSwapVideo = () => {
    if (playURLs.length === 2 && mainPlayURL && mutedPlayURL) {
      const mainVideo = mainVideoRef.current;
      const subVideo = subVideoRef.current;
      if (!mainVideo || !subVideo) {
        return;
      }

      const mainState = {
        currentTime: mainVideo.currentTime,
        paused: mainVideo.paused,
        playbackRate: mainVideo.playbackRate,
      };
      const subState = {
        currentTime: subVideo.currentTime,
        paused: subVideo.paused,
        playbackRate: subVideo.playbackRate,
      };

      setMainPlayURL(mutedPlayURL);
      setMutedPlayURL(mainPlayURL);

      setTimeout(() => {
        const newMain = mainVideoRef.current;
        const newSub = subVideoRef.current;
        if (newMain && newSub) {
          newMain.currentTime = subState.currentTime;
          newMain.playbackRate = subState.playbackRate;
          newSub.currentTime = mainState.currentTime;
          newSub.playbackRate = mainState.playbackRate;
          if (!subState.paused) {
            void newMain.play();
          } else {
            newMain.pause();
          }
          if (!mainState.paused) {
            void newSub.play();
          } else {
            newSub.pause();
          }
        }
      }, 200);
    }
  };

  const handleMainVideoJump = (time: number) => {
    if (!mainVideoRef.current) {
      messageApi.warning("当前未播放视频");
      return;
    }
    mainVideoRef.current.currentTime = time;
  };

  const noSubVideo = !mutedPlayURL;
  const subVideoSizes = [0, 10, 20, 25, 33, 40, 50];

  const positionSubVideo = () => {
    const container = playerContainerRef.current;
    if (!container || !mutedPlayURL) {
      return;
    }

    const padding = 24;
    const containerWidth = container.clientWidth;
    const overlayWidth = (containerWidth * subVideoSize) / 100;
    const maxX = Math.max(padding, containerWidth - overlayWidth - padding);
    setSubVideoPos({ x: maxX, y: padding });
  };

  const hookVideoHandlers = (swap: boolean) => {
    const mainVideo = mainVideoRef.current;
    const subVideo = subVideoRef.current;
    if (!mainVideo || !subVideo) {
      return;
    }

    if (!swap) {
      subVideo.currentTime = mainVideo.currentTime;
      if (!mainVideo.paused) {
        void subVideo.play();
      }
    }

    subVideo.onplay = null;
    mainVideo.onplay = () => void subVideo?.play();

    subVideo.onpause = null;
    mainVideo.onpause = () => subVideo?.pause();

    subVideo.onratechange = null;
    mainVideo.onratechange = () => {
      if (subVideo && mainVideo) {
        subVideo.playbackRate = mainVideo.playbackRate;
      }
    };

    subVideo.onseeked = null;
    mainVideo.onseeked = () => {
      if (subVideo && mainVideo) {
        subVideo.currentTime = mainVideo.currentTime;
      }
    };
  };

  useEffect(() => {
    if (!noSubVideo && syncPlay) {
      hookVideoHandlers(false);
    }
  }, [playURLs, noSubVideo, syncPlay]);

  useEffect(() => {
    if (!noSubVideo && syncPlay) {
      hookVideoHandlers(true);
    }
  }, [mainPlayURL, noSubVideo, syncPlay]);

  useEffect(() => {
    if (!mutedPlayURL) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      positionSubVideo();
    });

    const handleResize = () => positionSubVideo();
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, [mutedPlayURL, subVideoSize]);

  useEffect(() => {
    if (restoredCourseRef.current || courses.data.length === 0) {
      return;
    }

    restoredCourseRef.current = true;
    const storedCourseId = readStoredNumber(VIDEO_SELECTED_COURSE_STORAGE_KEY);
    if (!storedCourseId || !courses.data.some((course) => course.id === storedCourseId)) {
      if (storedCourseId) {
        window.localStorage.removeItem(VIDEO_SELECTED_COURSE_STORAGE_KEY);
      }
      return;
    }

    void handleSelectCourse(storedCourseId, { resetStoredVideo: false });
  }, [courses.data]);

  useEffect(() => {
    if (selectedCourseId <= 0 || videos.length === 0) {
      return;
    }

    if (restoredVideoForCourseRef.current === selectedCourseId) {
      return;
    }

    restoredVideoForCourseRef.current = selectedCourseId;
    const storedCourseId = readStoredNumber(VIDEO_SELECTED_COURSE_STORAGE_KEY);
    const storedVideoId = window.localStorage.getItem(VIDEO_SELECTED_VIDEO_STORAGE_KEY);
    if (storedCourseId !== selectedCourseId || !storedVideoId) {
      return;
    }

    if (!videos.some((video) => video.videoId === storedVideoId)) {
      window.localStorage.removeItem(VIDEO_SELECTED_VIDEO_STORAGE_KEY);
      return;
    }

    void handleSelectVideo(storedVideoId);
  }, [selectedCourseId, videos]);

  useEffect(() => {
    const fetchSubtitle = async () => {
      if (!selectedVideo || !mainPlayURL) {
        setSubtitleUrl(undefined);
        return;
      }
      try {
        const videoInfo = (await invoke("get_canvas_video_info", {
          videoId: selectedVideo.videoId,
        })) as VideoInfo;
        const srt = (await invoke("get_subtitle", {
          canvasCourseId: videoInfo.courId,
        })) as string;
        const vtt = srtToVtt(srt);
        const blob = new Blob([vtt], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        setSubtitleUrl(url);
      } catch {
        setSubtitleUrl(undefined);
      }
    };
    void fetchSubtitle();
  }, [mainPlayURL, selectedVideo]);

  useEffect(() => {
    if (!selectedVideo) {
      applySummaryResult(null);
      return;
    }

    let cancelled = false;
    const restoreCachedSummary = async () => {
      const config = await getConfig();
      const cacheKey = buildVideoSummaryCacheKey(selectedVideo.videoId, selectedCourseId);
      const cachedSummary =
        config.video_summary_cache?.[cacheKey] ??
        config.video_summary_cache?.[selectedVideo.videoId] ??
        null;

      if (!cancelled) {
        applySummaryResult(cachedSummary);
      }
    };

    void restoreCachedSummary();
    return () => {
      cancelled = true;
    };
  }, [selectedCourseId, selectedVideo]);

  const currentSummaryTaskKey = buildVideoSummaryCacheKey(
    selectedVideo?.videoId,
    selectedCourseId
  );
  const currentSummaryProgress = currentSummaryTaskKey
    ? summaryTaskProgressMap[currentSummaryTaskKey] ?? null
    : null;
  const summaryGenerating = Boolean(currentSummaryProgress);

  useEffect(() => {
    currentSummaryTaskKeyRef.current = currentSummaryTaskKey;
  }, [currentSummaryTaskKey]);

  const selectedCourse = courses.data.find((course) =>
    course.id === selectedCourseId
  );
  const summaryPreview = buildSummaryPreview(summaryContent);
  const summaryRequestPreview = buildSummaryRequestPreview(summarySubtitleContent);

  return (
    <BasicLayout>
      {contextHolder}
      <Stack spacing={3}>
        <ClosableAlert
          alertType="info"
          message="提示"
          configKey={VIDEO_PAGE_HINT_ALERT_KEY}
          description="依次点击主屏幕和副屏幕的播放按钮即可开启双窗口模式。"
        />

        {loaded && notLogin ? (
          <Alert
            severity="info"
            sx={{ borderRadius: "20px" }}
            action={
              <Button component={RouterLink} to="/settings" color="inherit" size="small">
                前往设置
              </Button>
            }
          >
            视频功能依赖额外扫码登录。你可以前往设置页，在“额外扫码登录”区域完成登录后再回来使用。
          </Alert>
        ) : null}

        <Dialog
          open={showLoginRequiredDialog && loaded && notLogin}
          onClose={() => setShowLoginRequiredDialog(false)}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle>需要额外登录</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 1 }}>
              <Typography variant="body1">
                视频相关功能需要额外扫码登录后才能使用。
              </Typography>
              <Typography variant="body2" color="text.secondary">
                登录入口已经放到设置页，你可以在那里主动完成扫码并保存登录态。
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, py: 2 }}>
            <Button onClick={() => setShowLoginRequiredDialog(false)}>稍后再说</Button>
            <Button
              component={RouterLink}
              to="/settings"
              variant="contained"
              onClick={() => setShowLoginRequiredDialog(false)}
            >
              前往设置页
            </Button>
          </DialogActions>
        </Dialog>

        <Card
          sx={{
            ...surfaceCardSx,
            background:
              theme.palette.mode === "dark"
                ? `linear-gradient(135deg, ${alpha(
                    theme.palette.primary.main,
                    0.18
                  )}, ${alpha("#0f172a", 0.9)})`
                : `linear-gradient(135deg, ${alpha(
                    theme.palette.primary.main,
                    0.1
                  )}, rgba(255,255,255,0.96))`,
          }}
        >
          <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
            <Stack spacing={3}>
              <Stack
                direction={{ xs: "column", lg: "row" }}
                justifyContent="space-between"
                spacing={2}
              >
                <Box>
                  <Typography variant="h4" sx={{ fontWeight: 800 }}>
                    视频中心
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    选择课程录像，下载视频、字幕、PPT，并支持双屏同步播放和课堂笔记生成。
                  </Typography>
                </Box>
                {!notLogin ? (
                  <Box
                    sx={{
                      width: "100%",
                      maxWidth: { xs: "100%", lg: 680 },
                      alignSelf: { xs: "stretch", lg: "flex-start" },
                    }}
                  >
                    <CourseSelect
                      courses={courses.data}
                      disabled={operating}
                      onChange={(courseId) => void handleSelectCourse(courseId)}
                      value={selectedCourseId === -1 ? undefined : selectedCourseId}
                    />
                  </Box>
                ) : null}
              </Stack>

              <Box
                sx={{
                  display: "grid",
                  gap: 2,
                  gridTemplateColumns: {
                    xs: "repeat(2, minmax(0, 1fr))",
                    lg: "repeat(4, minmax(0, 1fr))",
                  },
                }}
              >
                {[
                  { label: "课程视频", value: videos.length },
                  { label: "播放片段", value: plays.length },
                  { label: "视频任务", value: videoDownloadTasks.length },
                  { label: "PPT 任务", value: pptDownloadTasks.length },
                ].map((item) => (
                  <Card
                    key={item.label}
                    sx={{
                      borderRadius: "22px",
                      backgroundColor: alpha(theme.palette.background.paper, 0.8),
                      border: "1px solid",
                      borderColor: alpha(theme.palette.divider, 0.5),
                      boxShadow: "none",
                    }}
                  >
                    <CardContent sx={{ p: 2.25 }}>
                      <Typography variant="overline" color="text.secondary">
                        {item.label}
                      </Typography>
                      <Typography variant="h4" sx={{ fontWeight: 800, mt: 1 }}>
                        {item.value}
                      </Typography>
                    </CardContent>
                  </Card>
                ))}
              </Box>

              {!notLogin ? (
                <Box
                  sx={{
                    display: "grid",
                    gap: 2,
                    gridTemplateColumns: {
                      xs: "minmax(0, 1fr)",
                      xl: "minmax(0, 1.1fr) auto",
                    },
                    alignItems: "start",
                  }}
                >
                  <TextField
                    select
                    label="选择视频"
                    disabled={operating}
                    value={selectedVideo?.videoId ?? ""}
                    onChange={(event) =>
                      void handleSelectVideo(String(event.target.value))
                    }
                    helperText={
                      selectedVideo
                        ? `当前视频：${selectedVideo.videoName}`
                        : "选择一个课程后，这里会展示该课程的视频列表。"
                    }
                  >
                    {videos.map((video) => (
                      <MenuItem key={video.videoId} value={video.videoId}>
                        {`${video.videoName} ${video.courseBeginTime}`}
                      </MenuItem>
                    ))}
                  </TextField>

                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} useFlexGap flexWrap="wrap">
                    <Button
                      variant="outlined"
                      startIcon={<ClosedCaptionRoundedIcon />}
                      onClick={() => void handleDownloadSubtitle()}
                      disabled={!selectedVideo}
                    >
                      下载字幕
                    </Button>
                    <Button
                      variant="outlined"
                      startIcon={<PictureAsPdfRoundedIcon />}
                      onClick={() =>
                        void handleDownloadPPT(
                          selectedVideo?.videoId || "",
                          `${selectedVideo?.videoName}.pdf`
                        )
                      }
                      disabled={!selectedVideo}
                    >
                      下载 PPT
                    </Button>
                    <Button
                      variant="contained"
                      startIcon={<PsychologyRoundedIcon />}
                      onClick={() => void handleSummarizeSubtitle()}
                      disabled={!selectedVideo || summaryGenerating}
                    >
                      {summaryGenerating
                        ? "后台生成中..."
                        : summaryContent.trim()
                          ? "后台重新生成"
                          : "后台生成课堂笔记"}
                    </Button>
                  </Stack>
                </Box>
              ) : null}

              {selectedCourse ? (
                <Chip label={selectedCourse.name} color="primary" variant="outlined" />
              ) : null}
            </Stack>
          </CardContent>
        </Card>

        {!notLogin ? (
          <>
            <Card sx={surfaceCardSx}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>
                      课堂笔记摘要
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      这里会展示当前视频的 AI 课堂笔记摘要，并自动保存在本地配置里。点击顶部按钮后，字幕会发送给 AI 并在后台继续生成；你可以继续浏览页面，生成完成后这里会自动刷新。
                    </Typography>
                  </Box>

                  {selectedVideo ? (
                    <Card
                      variant="outlined"
                      sx={{
                        borderRadius: "22px",
                        borderColor: alpha(theme.palette.primary.main, 0.16),
                        bgcolor: alpha(theme.palette.primary.main, 0.05),
                      }}
                    >
                      <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
                        <Stack spacing={1.5}>
                          <Stack
                            direction={{ xs: "column", sm: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                            alignItems={{ xs: "flex-start", sm: "center" }}
                          >
                            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                              {selectedVideo.videoName}
                            </Typography>
                            <Chip
                              size="small"
                              color={summaryContent.trim() ? "primary" : "default"}
                              variant="outlined"
                              label={summaryContent.trim() ? "已缓存到本地" : "尚未生成课堂笔记"}
                            />
                          </Stack>

                          {summaryGenerating ? (
                            <Stack spacing={0.75}>
                              <Typography variant="body2" color="primary.main">
                                {currentSummaryProgress?.message ??
                                  "正在后台生成课堂笔记…"}
                              </Typography>
                              <LinearProgress
                                variant={
                                  currentSummaryProgress &&
                                  currentSummaryProgress.total > 0
                                    ? "determinate"
                                    : "indeterminate"
                                }
                                value={
                                  currentSummaryProgress &&
                                  currentSummaryProgress.total > 0
                                    ? Math.max(
                                        0,
                                        Math.min(
                                          100,
                                          (currentSummaryProgress.processed /
                                            currentSummaryProgress.total) *
                                            100
                                        )
                                      )
                                    : undefined
                                }
                              />
                            </Stack>
                          ) : null}

                          {summaryContent.trim() ? (
                            <>
                              <Typography
                                variant="body2"
                                color="text.secondary"
                                sx={{ lineHeight: 1.8 }}
                              >
                                {summaryPreview}
                              </Typography>
                              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                                <Button
                                  variant="outlined"
                                  size="small"
                                  onClick={() => setSummaryOpen(true)}
                                >
                                  查看完整课堂笔记
                                </Button>
                                <Button
                                  variant="text"
                                  size="small"
                                  onClick={() => void handleSummarizeSubtitle(true)}
                                  disabled={summaryGenerating}
                                >
                                  {summaryGenerating ? "后台生成中..." : "后台重新生成"}
                                </Button>
                              </Stack>
                            </>
                          ) : (
                            <Alert severity="info" sx={{ borderRadius: "16px" }}>
                              当前视频还没有生成课堂笔记。点击上方“后台生成课堂笔记”后，任务会转到后台继续运行；摘要生成完成后会显示在这里，并自动保存到本地。
                            </Alert>
                          )}
                        </Stack>
                      </CardContent>
                    </Card>
                  ) : (
                    <Alert severity="info" sx={{ borderRadius: "16px" }}>
                      先选择一个视频，再查看或生成该视频的课堂笔记摘要。
                    </Alert>
                  )}
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceCardSx}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>
                      播放片段
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      主屏一般是黑板视角，录屏轨道可作为副屏或下载对象。
                    </Typography>
                  </Box>

                  <Box
                    sx={{
                      borderRadius: "22px",
                      border: "1px solid",
                      borderColor: "divider",
                      overflow: "auto",
                    }}
                  >
                    <Table sx={{ minWidth: 720 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>视频名</TableCell>
                          <TableCell align="right">操作</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {plays.map((play) => (
                          <TableRow key={play.id} hover>
                            <TableCell>{play.name}</TableCell>
                            <TableCell align="right">
                              <Stack
                                direction="row"
                                spacing={1}
                                justifyContent="flex-end"
                                flexWrap="wrap"
                                useFlexGap
                              >
                                <Button
                                  size="small"
                                  variant="outlined"
                                  onClick={() => handleDownloadVideo(play)}
                                >
                                  下载
                                </Button>
                                <Button
                                  size="small"
                                  variant="contained"
                                  onClick={() => void handlePlay(play)}
                                >
                                  播放
                                </Button>
                              </Stack>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceCardSx}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Stack spacing={2.5}>
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>
                      播放控制
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      可调节副屏尺寸、透明度，并在双轨播放时切换主副屏。
                    </Typography>
                  </Box>

                  <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ xs: "stretch", md: "center" }}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={syncPlay}
                          onChange={(event) => setSyncPlay(event.target.checked)}
                          disabled={noSubVideo}
                        />
                      }
                      label="同步播放"
                    />
                    <Button
                      variant="outlined"
                      startIcon={<SwapHorizRoundedIcon />}
                      disabled={noSubVideo}
                      onClick={handleSwapVideo}
                    >
                      主副屏切换
                    </Button>
                    <TextField
                      select
                      label="副屏尺寸"
                      value={subVideoSize}
                      onChange={(event) => setSubVideoSize(Number(event.target.value))}
                      disabled={noSubVideo}
                      sx={{ width: { xs: "100%", md: 180 } }}
                    >
                      {subVideoSizes.map((size) => (
                        <MenuItem key={size} value={size}>
                          副屏：{size}%
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>

                  {!noSubVideo ? (
                    <Box sx={{ width: { xs: "100%", md: 360 } }}>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        副屏透明度
                      </Typography>
                      <Slider
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={subVideoOpacity}
                        onChange={(_, value) => setSubVideoOpacity(value as number)}
                      />
                    </Box>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceCardSx}>
              <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
                <Stack spacing={2}>
                  <Typography variant="h6" sx={{ fontWeight: 800 }}>
                    播放器
                  </Typography>
                  <Box
                    className={videoStyles.videoPlayerContainer}
                    sx={{
                      borderRadius: "22px",
                      overflow: "hidden",
                      bgcolor: "#000",
                    }}
                  >
                    <Box
                      ref={playerContainerRef}
                      sx={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: "16 / 9",
                        minHeight: 360,
                        bgcolor: "#000",
                      }}
                    >
                      {mainPlayURL ? (
                        <video
                          ref={mainVideoRef}
                          controls
                          autoPlay={false}
                          src={mainPlayURL}
                          muted={false}
                          width="100%"
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "block",
                            objectFit: "contain",
                            background: "#000",
                          }}
                        >
                          {subtitleUrl ? (
                            <track
                              label="字幕"
                              kind="subtitles"
                              src={subtitleUrl}
                              srcLang="zh"
                              default
                            />
                          ) : null}
                        </video>
                      ) : (
                        <Box
                          sx={{
                            position: "absolute",
                            inset: 0,
                            display: "grid",
                            placeItems: "center",
                            color: "#fff",
                          }}
                        >
                          <Stack spacing={1.25} alignItems="center">
                            <VideoLibraryRoundedIcon sx={{ fontSize: 44, opacity: 0.8 }} />
                            <Typography variant="body1">选择片段后在这里开始播放</Typography>
                          </Stack>
                        </Box>
                      )}

                      {!noSubVideo && mutedPlayURL ? (
                        <Draggable
                          bounds="parent"
                          position={subVideoPos}
                          onStop={(_: DraggableEvent, data: DraggableData) =>
                            setSubVideoPos({ x: data.x, y: data.y })
                          }
                          disabled={noSubVideo}
                        >
                          <div
                            style={{
                              position: "absolute",
                              zIndex: 1000,
                              opacity: subVideoOpacity,
                              pointerEvents: noSubVideo ? "none" : "auto",
                              width: `${subVideoSize}%`,
                              left: 0,
                              top: 0,
                              display: mutedPlayURL ? "block" : "block",
                              boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
                              borderRadius: 12,
                              background: "#000",
                              overflow: "hidden",
                            }}
                          >
                            <video
                              ref={subVideoRef}
                              controls
                              autoPlay={false}
                              src={mutedPlayURL}
                              muted
                              style={{
                                width: "100%",
                                height: "100%",
                                display: "block",
                                objectFit: "contain",
                                background: "#000",
                              }}
                            />
                          </div>
                        </Draggable>
                      ) : null}
                    </Box>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <VideoDownloadTable
              tasks={videoDownloadTasks}
              handleRemoveTask={handleRemoveTask}
            />
            <PPTDownloadTable
              tasks={pptDownloadTasks}
              handleRemoveTask={handleRemovePPTTask}
            />
          </>
        ) : null}

        <Card sx={surfaceCardSx}>
          <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
            <Stack spacing={2}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>
                视频合并
              </Typography>
              <VideoAggregator />
            </Stack>
          </CardContent>
        </Card>
      </Stack>

      <Dialog
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        fullWidth
        maxWidth="lg"
      >
        <DialogTitle>{selectedVideo ? `${selectedVideo.videoName} · 课堂笔记` : "课堂笔记"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ py: 1 }}>
            <Card variant="outlined" sx={{ borderRadius: "20px" }}>
              <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <PsychologyRoundedIcon color="primary" fontSize="small" />
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                      课堂笔记
                    </Typography>
                  </Stack>
                  <Box sx={{ "& a": { color: "primary.main" } }}>
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={{ code: LinkRenderer }}
                    >
                      {summaryContent}
                    </Markdown>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <Card variant="outlined" sx={{ borderRadius: "20px" }}>
              <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
                <Stack spacing={1.5}>
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={1}
                    justifyContent="space-between"
                    alignItems={{ xs: "flex-start", sm: "center" }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <ClosedCaptionRoundedIcon color="primary" fontSize="small" />
                      <Typography variant="h6" sx={{ fontWeight: 700 }}>
                        发送给 LLM 的请求内容
                      </Typography>
                    </Stack>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={summaryRequestPreview ? "已展示提示词和字幕" : "暂无请求内容"}
                    />
                  </Stack>

                  <Alert severity="info" sx={{ borderRadius: "16px" }}>
                    这里展示的是发送给 LLM 的请求预览：上方提示词加下方整理后字幕。若视频较长，系统会基于这份内容按长度自动分段调用模型。
                  </Alert>

                  {summaryRequestPreview ? (
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 2,
                        borderRadius: "16px",
                        border: "1px solid",
                        borderColor: "divider",
                        bgcolor: alpha(theme.palette.info.main, 0.04),
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: 14,
                        lineHeight: 1.7,
                        fontFamily:
                          '"SFMono-Regular", ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace',
                        maxHeight: 360,
                        overflowY: "auto",
                      }}
                    >
                      {summaryRequestPreview}
                    </Box>
                  ) : (
                    <Alert severity="warning" sx={{ borderRadius: "16px" }}>
                      当前没有可展示的请求内容。
                    </Alert>
                  )}
                </Stack>
              </CardContent>
            </Card>

          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => void handleSaveSummary()}>导出 Markdown</Button>
          <Button variant="contained" onClick={() => setSummaryOpen(false)}>
            关闭
          </Button>
        </DialogActions>
      </Dialog>
    </BasicLayout>
  );
}
