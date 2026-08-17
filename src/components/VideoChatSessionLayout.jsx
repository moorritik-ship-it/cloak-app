import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, PhoneOff, SkipForward } from 'lucide-react'
import { FILTERS } from '../hooks/useCanvasVideoFilters.js'
import { CHAT_MAX_CHARS, clampChatInput, countGraphemes } from '../utils/chatText.js'

function formatTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * 70% video column + 30% chat panel. Header: partner name, timer, mute, next, end.
 */
export default function VideoChatSessionLayout({
  partnerName,
  displayName,
  sessionEndAtMs,
  isSearching,
  micMuted,
  filterId,
  onMicToggle,
  onFilterChange,
  onNext,
  onEndChat,
  nextDisabled = false,
  messages = [],
  chatError = null,
  chatEnabled = false,
  currentUserId = null,
  onSendMessage,
  children,
}) {
  const [input, setInput] = useState('')
  const [tick, setTick] = useState(0)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 500)
    return () => window.clearInterval(id)
  }, [])

  void tick

  const remainingMs =
    sessionEndAtMs && !isSearching ? Math.max(0, sessionEndAtMs - Date.now()) : 0

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || countGraphemes(text) < 1) return
    onSendMessage?.(text)
    setInput('')
  }, [input, onSendMessage])

  return (
    <div className="vc-session vc-session--rewritten flex min-h-0 w-full max-w-[100vw] flex-col overflow-hidden bg-[var(--background)] md:max-h-[calc(100vh-4.5rem)] md:min-h-[calc(100vh-4.5rem)]">
      <header className="vc-header flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3">
        <div className="min-w-0">
          <p className="vc-partner-label m-0 text-xs uppercase tracking-wide opacity-70">Partner</p>
          <p className="vc-partner-name m-0 truncate text-lg font-bold">
            {isSearching ? 'Searching…' : partnerName || 'Partner'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!isSearching && sessionEndAtMs ? (
            <div className="vc-session-timer-wrap text-right">
              <p className="vc-session-timer-label m-0 text-xs opacity-70">Session</p>
              <p className="vc-session-timer-big m-0 font-mono text-lg font-bold">{formatTimer(remainingMs)}</p>
            </div>
          ) : null}
          <button
            type="button"
            className={`vc-tool-btn ${micMuted ? 'vc-tool-btn--off' : ''}`}
            onClick={onMicToggle}
            aria-label={micMuted ? 'Unmute' : 'Mute'}
          >
            {micMuted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button
            type="button"
            className="vc-btn-next"
            onClick={onNext}
            disabled={nextDisabled || isSearching}
          >
            <SkipForward size={18} />
            <span>Next</span>
          </button>
          <button type="button" className="vc-btn-end" onClick={onEndChat}>
            <PhoneOff size={18} />
            <span>End Chat</span>
          </button>
        </div>
      </header>

      {!isSearching ? (
        <div className="vc-header-filters border-b border-[var(--border-color)] px-4 py-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`vc-filter-chip vc-filter-chip--header ${filterId === f.id ? 'is-active' : ''}`}
              onClick={() => onFilterChange?.(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="vc-body flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="vc-video-col relative min-h-0 min-w-0 flex-[7] md:flex-[7]">{children}</div>
        <aside className="vc-chat-desktop flex min-h-0 min-w-0 flex-[3] flex-col border-l border-[var(--border-color)] md:flex-[3]">
          <div className="vc-chat-desktop-head border-b border-[var(--border-color)] px-4 py-3">
            <h2 className="vc-chat-heading m-0 text-base font-bold">Chat</h2>
            <p className="vc-chat-you m-0 mt-1 text-sm opacity-80">
              You: <strong>{displayName}</strong>
            </p>
          </div>
          <div className="vc-chat-panel vc-chat-panel--desktop flex min-h-0 flex-1 flex-col">
            <div className="vc-chat-messages min-h-0 flex-1 overflow-y-auto p-3" role="log">
              {messages.length === 0 ? (
                <p className="vc-chat-empty text-sm opacity-60">No messages yet. Say hello!</p>
              ) : (
                messages.map((m) => {
                  const mine = currentUserId && m.sender_user_id === currentUserId
                  return (
                    <div
                      key={m.id}
                      className={`vc-chat-bubble mb-2 ${mine ? 'vc-chat-bubble--me' : 'vc-chat-bubble--peer'}`}
                    >
                      <div className="vc-chat-meta text-xs opacity-70">
                        <span>{m.sender_username || 'User'}</span>
                        <span className="ml-2">{formatTime(m.sent_at)}</span>
                      </div>
                      <div className="vc-chat-body">{m.text}</div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>
            {chatError ? (
              <p className="vc-chat-inline-error px-3 text-sm text-red-400" role="alert">
                {chatError}
              </p>
            ) : null}
            <div className="vc-chat-compose flex gap-2 border-t border-[var(--border-color)] p-3">
              <input
                type="text"
                className="vc-chat-input min-w-0 flex-1 rounded-lg border border-[var(--border-color)] bg-transparent px-3 py-2"
                placeholder={chatEnabled ? 'Message…' : 'Chat unavailable…'}
                value={input}
                onChange={(e) => setInput(clampChatInput(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    send()
                  }
                }}
                disabled={!chatEnabled}
              />
              <button
                type="button"
                className="vc-chat-send rounded-lg px-4 py-2 font-semibold"
                onClick={send}
                disabled={!chatEnabled || countGraphemes(input) < 1}
              >
                Send
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
