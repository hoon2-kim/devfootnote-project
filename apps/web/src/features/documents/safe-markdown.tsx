import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

export function SafeMarkdown({ body }: { body: string }) {
  return (
    <div className="space-y-4 leading-7 text-text-secondary [&_a]:text-action-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-text-muted [&_blockquote]:pl-4 [&_code]:break-all [&_code]:rounded [&_code]:bg-canvas [&_code]:px-1 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:ml-6 [&_ol]:list-decimal [&_p]:whitespace-pre-wrap [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-canvas [&_pre]:p-4 [&_pre_code]:break-normal [&_ul]:list-disc">
      <Markdown
        skipHtml
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children} ({href}, 새 탭)
              </a>
            ) : (
              <span>{children}</span>
            ),
          // 저장 자료 열람만으로 외부 이미지 서버에 접속하지 않는다. 이미지는 설명으로 표시한다.
          img: ({ alt }) => <span className="text-text-muted">[이미지: {alt || '설명 없음'}]</span>,
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h3>{children}</h3>,
          h3: ({ children }) => <h3>{children}</h3>,
          h4: ({ children }) => <h3>{children}</h3>,
          h5: ({ children }) => <h3>{children}</h3>,
          h6: ({ children }) => <h3>{children}</h3>,
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
