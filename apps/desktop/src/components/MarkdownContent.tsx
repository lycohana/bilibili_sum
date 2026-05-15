import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { normalizeRenderableMarkdown } from "../utils";

type MarkdownContentProps = {
  className?: string;
  compact?: boolean;
  content: string;
  imageResolver?: (src: string) => string;
};

export function MarkdownContent({ className = "", compact = false, content, imageResolver }: MarkdownContentProps) {
  const markdown = normalizeRenderableMarkdown(content).trim();
  if (!markdown) {
    return null;
  }

  const rootClassName = ["markdown-content", compact ? "markdown-content-compact" : "", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      <ReactMarkdown
        rehypePlugins={[[rehypeKatex, { output: "html", strict: "ignore", throwOnError: false }]]}
        remarkPlugins={[remarkGfm, remarkMath]}
        urlTransform={(url, key, node) => {
          if (key === "src" && node.tagName === "img" && imageResolver) {
            const resolvedUrl = imageResolver(String(url));
            if (resolvedUrl !== url) {
              return resolvedUrl;
            }
          }
          return defaultUrlTransform(url);
        }}
        components={{
          img({ src = "", alt = "" }) {
            return <img src={String(src)} alt={String(alt || "")} loading="lazy" />;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
