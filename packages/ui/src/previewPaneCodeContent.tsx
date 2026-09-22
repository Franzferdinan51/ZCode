import type { BundledLanguage, BundledTheme } from "shiki";
import type { Ref, UIEventHandler } from "react";
import { Suspense, lazy } from "react";
import { cn } from "@/components/lib/utils.js";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import type { CodeCommentLabels } from "@/components/ui/code-viewer.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import { isMermaidLanguage } from "@/lib/mermaidLanguage.js";
import type { Theme } from "@/useTheme.js";

// Mermaid's renderer must not ride the code-preview entry chunk; only mermaid
// sources render it.
const MermaidBlock = lazy(() =>
  import("@/components/ai-elements/mermaid-block.js").then((module) => ({
    default: module.MermaidBlock,
  })),
);

interface CodeContentProps {
  code: string;
  language: BundledLanguage;
  codePreviewSettings: CodePreviewSettings;
  codeTheme: BundledTheme;
  /** 应用主题（store 耦合剥离）：透传给 Mermaid 预览，缺省按 "system" 兜底。 */
  theme?: Theme;
  wrapLongLines: boolean;
  firstLineNumber?: number;
  comments?: readonly CodeCommentPreview[];
  topComment?: CodeCommentPreview | null;
  topCommentShowRange?: boolean;
  topCommentNotice?: string;
  focusedRange?: CodeCommentRange | null;
  focusRequestId?: string;
  enableLineSelection?: boolean;
  enableGutterUtility?: boolean;
  labels?: Partial<CodeCommentLabels>;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
  className?: string;
}

export function CodeContent({
  code,
  language,
  codePreviewSettings,
  codeTheme,
  theme,
  wrapLongLines,
  firstLineNumber,
  comments,
  topComment,
  topCommentShowRange,
  topCommentNotice,
  focusedRange,
  focusRequestId,
  enableLineSelection = false,
  enableGutterUtility = false,
  labels,
  onSubmitCodeComment,
  onDeleteCodeComment,
  onScroll,
  scrollContainerRef,
  className,
}: CodeContentProps) {
  if (isMermaidLanguage(language)) {
    return (
      <div
        ref={scrollContainerRef}
        className={cn("h-full w-full overflow-auto bg-background p-4", className)}
        onScroll={onScroll}
      >
        <Suspense fallback={null}>
          <MermaidBlock
            code={code}
            theme={theme}
            className="min-h-full rounded-xl border border-border"
          />
        </Suspense>
      </div>
    );
  }

  return (
    <CodeViewer
      code={code}
      language={language}
      showLineNumbers={codePreviewSettings.showLineNumbers}
      theme={codeTheme}
      wrapLongLines={wrapLongLines}
      fontSizePx={codePreviewSettings.fontSizePx}
      firstLineNumber={firstLineNumber}
      comments={comments}
      topComment={topComment}
      topCommentShowRange={topCommentShowRange}
      topCommentNotice={topCommentNotice}
      focusedRange={focusedRange}
      focusRequestId={focusRequestId}
      enableLineSelection={enableLineSelection}
      enableGutterUtility={enableGutterUtility}
      labels={labels}
      onSubmitCodeComment={onSubmitCodeComment}
      onDeleteCodeComment={onDeleteCodeComment}
      onScroll={onScroll}
      scrollContainerRef={scrollContainerRef}
      className={className}
    />
  );
}
