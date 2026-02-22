import { useState, useRef, useEffect } from "react";
import { chatWithSlides, getPdfUrl, getFileUrl, isPdf } from "./api";
import type { ChatMessage, ChatSource } from "./api";

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
}

function ChatView() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;

    const userMsg: DisplayMessage = { role: "user", content: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setError("");

    // Build history for API (exclude sources)
    const history: ChatMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const res = await chatWithSlides(q, history);
      const assistantMsg: DisplayMessage = {
        role: "assistant",
        content: res.answer,
        sources: res.sources,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = () => {
    setMessages([]);
    setError("");
  };

  return (
    <div className="chat-view">
      <div className="chat-messages">
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            Ask a question about your slides and LectureLens will find relevant
            content and answer with citations.
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-bubble chat-bubble-${msg.role}`}>
            <div className="chat-bubble-content">{msg.content}</div>
            {msg.sources && msg.sources.length > 0 && (
              <div className="chat-sources">
                <span className="chat-sources-label">Sources:</span>
                {msg.sources.map((s, j) => (
                  <a
                    key={j}
                    className="chat-source-link"
                    href={isPdf(s.file_path) ? getPdfUrl(s.file_path, s.page_number) : getFileUrl(s.file_path)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {s.file_path}{isPdf(s.file_path) ? ` p${s.page_number}` : ""}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-bubble chat-bubble-assistant">
            <div className="chat-bubble-content chat-thinking">
              <span className="spinner spinner-small" /> Thinking...
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          placeholder="Ask about your slides..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          rows={2}
        />
        <div className="chat-input-actions">
          <button
            className="btn btn-search"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
          {messages.length > 0 && (
            <button className="btn btn-secondary" onClick={handleClear}>
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatView;
