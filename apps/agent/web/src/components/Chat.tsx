import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, Unauthorized, type ChatMessage } from "../api";

const EXAMPLES = ["How is the account doing this week?", "Which ad set is wasting money?", "Why did CPA go up on as_women_video?"];

export function Chat({ code, onAnswer, onUnauthorized }: { code: string; onAnswer: () => void; onUnauthorized: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Braces matter: an effect must return nothing or a cleanup function, and scrollIntoView returns a Promise in recent browsers.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const ask = async (question: string) => {
    if (!question.trim() || sending) return;
    const history = messages;
    setMessages([...history, { role: "user", content: question }]);
    setInput("");
    setSending(true);
    setError(null);
    try {
      const { answer } = await api.chat(code, question, history);
      setMessages((m) => [...m, { role: "assistant", content: answer }]);
      onAnswer(); // a pause request may have been created
    } catch (err) {
      if (err instanceof Unauthorized) onUnauthorized();
      else setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  return (
    <section className="card chat">
      <h2>Ask the analyst</h2>
      <div className="messages">
        {messages.length === 0 && (
          <div className="examples">
            <p className="muted">Answers come from the ad account's data, with sources and a confidence level. Try:</p>
            {EXAMPLES.map((q) => (
              <button key={q} className="chip" onClick={() => void ask(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          // Answers are plain text with line breaks; React escapes the text, so nothing from the API runs as HTML.
          <div key={i} className={`message ${m.role}`}>
            {m.content}
          </div>
        ))}
        {sending && <div className="message assistant muted">Looking at the data...</div>}
        {error && <p className="error">{error}</p>}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about spend, CPA, ROAS, or ask to pause an ad set" />
        <button disabled={sending || !input.trim()}>Send</button>
      </form>
    </section>
  );
}
