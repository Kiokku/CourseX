import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
export function Markdown({ text, lesson }: { text: string; lesson?: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url, key) => {
        if (lesson && key === "src" && !/^(https?:|data:|\/\/)/i.test(url)) {
          return `/api/lessons/${lesson}/media?file=${encodeURIComponent(url.replace(/^\.\//, ""))}`;
        }
        return defaultUrlTransform(url);
      }}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {typeof children === "string" &&
            children === props.href &&
            props.href.includes(".h5.xiaoeknow.com/")
              ? "查看课程来源"
              : children}
          </a>
        ),
        img: (props) =>
          props.src ? (
            <img {...props} src={props.src} loading="lazy" />
          ) : (
            <span>{props.alt}</span>
          ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
