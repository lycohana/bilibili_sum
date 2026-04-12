import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type MarkdownContentProps = {
  className?: string;
  compact?: boolean;
  content: string;
};

export function MarkdownContent({ className = "", compact = false, content }: MarkdownContentProps) {
  const markdown = String(content || "").trim();
  if (!markdown) {
    return null;
  }

  const rootClassName = ["markdown-content", compact ? "markdown-content-compact" : "", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      <ReactMarkdown
        rehypePlugins={[[rehypeKatex, { output: "html", strict: "ignore", throwOnError: false }]]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
