import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import SchoolRoundedIcon from "@mui/icons-material/SchoolRounded";
import {
  Autocomplete,
  Box,
  Chip,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useMemo } from "react";

import { Course } from "../lib/model";

interface CourseSelectExtraOption {
  id: number;
  label: string;
  helperText?: string;
}

type CourseSelectOption =
  | {
      id: number;
      label: string;
      searchText: string;
      optionType: "course";
      course: Course;
    }
  | {
      id: number;
      label: string;
      searchText: string;
      optionType: "extra";
      helperText?: string;
    };

export default function CourseSelect({
  courses,
  disabled,
  onChange,
  value,
  extraOptions,
}: {
  courses: Course[];
  disabled?: boolean;
  onChange?: (courseId: number) => void;
  value?: number;
  extraOptions?: CourseSelectExtraOption[];
}) {
  const formatCourseName = (course: Course): string => {
    const term = course.term.name.replace("Spring", "春").replace("Fall", "秋");
    const teacherNames =
      course.teachers
        ?.filter((teacher) => teacher?.display_name)
        .map((teacher) => teacher.display_name)
        .slice(0, 2) || [];

    const teacherText = teacherNames.length > 0 ? teacherNames.join("、") : "未知教师";
    return `${course.name} | ${term} | ${teacherText}`;
  };

  const options = useMemo<CourseSelectOption[]>(() => {
    const pinnedOptions =
      extraOptions?.map((option) => ({
        id: option.id,
        label: option.label,
        searchText: `${option.label} ${option.helperText ?? ""}`.toLowerCase(),
        optionType: "extra" as const,
        helperText: option.helperText,
      })) ?? [];

    const formattedCourses = [...courses]
      .map((course) => ({
        id: course.id,
        label: formatCourseName(course),
        searchText: formatCourseName(course).toLowerCase(),
        optionType: "course" as const,
        course,
      }))
      .sort((a, b) => b.course.term.id - a.course.term.id);

    return [...pinnedOptions, ...formattedCourses];
  }, [courses, extraOptions]);

  const selectedOption = options.find((option) => option.id === value) ?? undefined;

  const hasCourses = options.length > 0;
  const theme = useTheme();

  return (
    <Stack
      direction={{ xs: "column", md: "row" }}
      spacing={1.5}
      alignItems={{ xs: "stretch", md: "stretch" }}
      sx={{ width: "100%" }}
    >
      <Box
        sx={{
          minWidth: { xs: "100%", md: 148 },
          px: 1.75,
          py: 1.5,
          borderRadius: "20px",
          border: "1px solid",
          borderColor: alpha(theme.palette.primary.main, 0.14),
          bgcolor: alpha(theme.palette.primary.main, 0.06),
        }}
      >
        <Stack spacing={0.75}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 700, color: "text.primary" }}
          >
            选择课程
          </Typography>
          <Typography variant="caption" color="text.secondary">
            支持按课程、学期和教师搜索
          </Typography>
        </Stack>
      </Box>

      <Autocomplete
        fullWidth
        disableClearable
        disabled={disabled || !hasCourses}
        options={options}
        value={selectedOption}
        onChange={(_, nextValue) => onChange?.(nextValue?.id ?? -1)}
        getOptionLabel={(option) => option.label}
        isOptionEqualToValue={(option, currentValue) => option.id === currentValue.id}
        noOptionsText="暂无可用课程"
        PaperComponent={(props) => (
          <Paper
            {...props}
            sx={{
              mt: 1,
              borderRadius: "22px",
              border: "1px solid",
              borderColor: "divider",
              boxShadow: "0 24px 60px rgba(15, 23, 42, 0.12)",
              overflow: "hidden",
            }}
          />
        )}
        renderOption={(props, option) => {
          if (option.optionType === "extra") {
            return (
              <Box
                component="li"
                {...props}
                sx={{
                  px: 2,
                  py: 1.35,
                  alignItems: "stretch",
                }}
              >
                <Stack spacing={0.65} sx={{ minWidth: 0, width: "100%" }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 700, wordBreak: "break-word" }}
                    >
                      {option.label}
                    </Typography>
                    <Chip size="small" color="primary" label="置顶选项" />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {option.helperText ?? "快捷查看聚合结果"}
                  </Typography>
                </Stack>
              </Box>
            );
          }

          const isTA = option.course.enrollments?.some(
            (enrollment) => enrollment.role === "TaEnrollment"
          );
          const teacherNames =
            option.course.teachers
              ?.filter((teacher) => teacher?.display_name)
              .map((teacher) => teacher.display_name)
              .slice(0, 2)
              .join("、") || "未知教师";
          const term = option.course.term.name.replace("Spring", "春").replace("Fall", "秋");

          return (
            <Box
              component="li"
              {...props}
              sx={{
                px: 2,
                py: 1.35,
                alignItems: "stretch",
              }}
            >
              <Stack spacing={0.65} sx={{ minWidth: 0, width: "100%" }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 700, wordBreak: "break-word" }}
                  >
                    {option.label.split(" | ")[0]}
                  </Typography>
                  {isTA ? <Chip size="small" color="error" label="助教" /> : null}
                </Stack>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Chip
                    size="small"
                    label={term}
                    variant="outlined"
                    sx={{ borderRadius: "10px" }}
                  />
                  <Chip
                    size="small"
                    label={teacherNames}
                    variant="outlined"
                    sx={{ borderRadius: "10px", maxWidth: "100%" }}
                  />
                </Stack>
              </Stack>
            </Box>
          );
        }}
        filterOptions={(options, state) => {
          const keyword = state.inputValue.trim().toLowerCase();
          if (!keyword) {
            return options;
          }

          return options.filter((option) => option.searchText.includes(keyword));
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={hasCourses ? "请选择或搜索课程…" : "暂无可用课程"}
            helperText={
              selectedOption
                ? `当前已选：${
                    selectedOption.optionType === "course"
                      ? selectedOption.label.split(" | ")[0]
                      : selectedOption.label
                  }`
                : "优先展示最近学期课程，支持关键字快速定位。"
            }
            sx={{
              "& .MuiOutlinedInput-root": {
                minHeight: 64,
                borderRadius: "20px",
                bgcolor: alpha(theme.palette.background.paper, 0.72),
              },
            }}
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <>
                  <InputAdornment position="start">
                    <SchoolRoundedIcon color="action" />
                  </InputAdornment>
                  {params.InputProps.startAdornment}
                </>
              ),
            }}
          />
        )}
      />

      <Box
        sx={{
          display: "grid",
          placeItems: "center",
          px: 1,
        }}
      >
        <Tooltip title="带“助教”标识的课程表示你在该课程中担任助教">
          <InfoOutlinedIcon color="action" />
        </Tooltip>
      </Box>
    </Stack>
  );
}
