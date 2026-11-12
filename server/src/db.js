import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { id, now } from './util.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// DB_PATH lets a throwaway instance run against a COPY of the database — the real
// file holds live org data, so exercising anything that writes (splits,
// reassignment) must never touch it. Unset in normal use.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'smarttask.db')
// The RAG search worker opens its own read-only connection to the same file.
export const DB_FILE = DB_PATH

// Ensure the data directory exists.
import fs from 'node:fs'
fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

export function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    department_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','employee')),
    phone TEXT DEFAULT '',
    -- comma-separated aliases the AI can match against spoken names (e.g. "Munidhar,Muni")
    aliases TEXT DEFAULT '',
    preferred_language TEXT DEFAULT 'en',
    avatar_color TEXT DEFAULT '#6366f1',
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id),
    FOREIGN KEY (department_id) REFERENCES departments(id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    department_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    uploaded_by TEXT,
    source_type TEXT DEFAULT 'transcript',     -- transcript | audio
    audio_filename TEXT,
    raw_transcript TEXT,                        -- original, language preserved
    detected_languages TEXT DEFAULT '[]',       -- JSON array
    status TEXT DEFAULT 'uploaded',             -- uploaded | processing | processed | failed
    summary_json TEXT,                          -- JSON: executive summary, decisions, risks...
    engine TEXT,                                -- claude | rule-based
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    language TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    assignee_id TEXT,
    assignee_name_raw TEXT,                     -- name as spoken, before matching
    assigned_by_id TEXT,
    assigned_by_name_raw TEXT,
    due_date TEXT,
    due_date_raw TEXT,                          -- the original natural-language phrase
    priority TEXT DEFAULT 'Medium' CHECK (priority IN ('Critical','High','Medium','Low')),
    status TEXT DEFAULT 'To Do',                -- To Do | In Progress | Blocked | In Review | Done | Reopened
    project_id TEXT,
    department_id TEXT,
    meeting_id TEXT,                            -- origin meeting, if any
    ownership_confidence TEXT DEFAULT 'high',   -- high | low | needs_confirmation
    parent_task_id TEXT,                        -- for subtasks
    progress INTEGER DEFAULT 0,                 -- 0-100
    approval_status TEXT DEFAULT 'none',        -- none | pending | approved | rejected
    source_quote TEXT,                          -- exact transcript line that created it
    assigned_at TEXT,                           -- when an owner was set
    submitted_at TEXT,                          -- when the assignee submitted for review
    completed_at TEXT,                          -- when it was marked Done/approved
    visible_to_manager INTEGER DEFAULT 1,       -- 0 = private employee draft, hidden until submitted
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id),
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  -- AI / external API usage, one row per provider call, attributed to an org.
  -- Powers per-organization usage tracking (calls, tokens, estimated cost).
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT,
    provider TEXT NOT NULL,                       -- sarvam | openrouter | anthropic | openai | groq
    feature TEXT NOT NULL,                        -- transcription | assistant | voice_search | voice_task | meeting_analysis
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_org ON usage_events(org_id, created_at);

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,                       -- recipient
    type TEXT NOT NULL,                          -- task_submitted | task_approved | task_reopened | task_assigned
    message TEXT NOT NULL,
    task_id TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);

  -- FCM device tokens for native push (one row per device; pushes target a user's rows).
  -- One row per LOGIN, so "where am I signed in?" has an answer. JWTs are
  -- stateless and long-lived (30d), so without this a token could not be taken
  -- back once issued: signing out on a lost phone did nothing to the token in
  -- its storage. Each token now carries its session id and every request checks
  -- the row, which is what makes revoking real.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device TEXT,                                -- 'Android app', 'Chrome on Windows', …
    ip TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,                            -- set = signed out, token refused
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_seen_at);

  CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL DEFAULT 'android',
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_devtok_user ON device_tokens(user_id);

  -- Requests to join an org via its shareable link / org code. Deliberately NOT
  -- rows in the users table: a pending person must be invisible to every existing
  -- query (dashboards, assignee pickers, chat, leaderboard, RAG retrieval), and a
  -- users.status column would have meant auditing every one of them to add a
  -- filter. Nothing here becomes a user until a manager approves, at which point
  -- the row is replayed into users with the password they already chose.
  CREATE TABLE IF NOT EXISTS join_requests (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Send-once ledger for the per-owner critical task emails (src/taskMail.js).
  -- Those two alerts are found by polling rather than by a hook in the task
  -- routes, so "have I already told them about this one?" has to be written down.
  -- due_date is part of the key, not a detail: it is the deadline the warning was
  -- about, so moving a task's date deliberately re-arms its 1-hour warning. It is
  -- NOT NULL with a '' default because SQLite permits NULLs in a PRIMARY KEY and
  -- would then stop de-duplicating the rows that matter most.
  CREATE TABLE IF NOT EXISTS critical_alerts_sent (
    task_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,                         -- assigned | deadline
    due_date TEXT NOT NULL DEFAULT '',
    sent_at TEXT NOT NULL,
    PRIMARY KEY (task_id, owner_id, kind, due_date)
  );

  -- Voice-agent learning log: one row per /assistant/command turn — what was said,
  -- what the agent decided, and (reported back by the client afterwards) what became
  -- of it. outcome is the LABEL that makes this a training set, not just telemetry:
  -- executed = the routing was right; cancelled/undone = it was wrong in a way the
  -- user had to correct; failed = it broke. "learn" holds a pending side-lesson
  -- (e.g. a fuzzily-matched spoken name -> user alias) that is applied only once the
  -- outcome proves the guess right. See routes/assistant.js and eval/voiceEval.mjs.
  CREATE TABLE IF NOT EXISTS voice_turns (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    transcript TEXT NOT NULL,
    tool TEXT,
    args TEXT,                -- JSON: the resolved action/args the dispatcher produced
    mode TEXT,                -- do | confirm | answer | clarify | navigate
    say TEXT,
    engine TEXT,              -- model that routed it (null = legacy/fallback path)
    lookups INTEGER,
    rounds INTEGER,
    latency_ms INTEGER,
    learn TEXT,               -- JSON lesson candidate, applied when outcome=executed
    outcome TEXT,             -- executed | cancelled | undone | failed (null = unreported)
    outcome_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voice_turns_org_time ON voice_turns(org_id, created_at);

  -- RAG vector store. One row per indexed chunk of org data (a task, a meeting
  -- summary, a transcript segment, or a chat message). vector is a raw Float32
  -- BLOB; similarity is computed in JS (see ai/embeddings.js). content_hash lets
  -- us skip re-embedding text that hasn't changed. ref_user_id / ref_convo_id
  -- carry the visibility keys used to enforce RBAC at retrieval time.
  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    source_type TEXT NOT NULL,                  -- task | meeting | segment | chat
    source_id TEXT NOT NULL,                     -- id of the row this chunk came from
    ref_user_id TEXT,                            -- task assignee (employee-scope filter)
    ref_convo_id TEXT,                           -- chat conversation (membership filter)
    chunk_text TEXT NOT NULL,                     -- the human-readable text that was embedded
    content_hash TEXT NOT NULL,                   -- hash of chunk_text; skip re-embed if unchanged
    dim INTEGER NOT NULL,                         -- vector dimensions
    vector BLOB NOT NULL,                         -- Float32Array bytes
    model TEXT,                                   -- embedding model used
    updated_at TEXT NOT NULL,
    UNIQUE (source_type, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_emb_org ON embeddings(org_id, source_type);

  -- Internal team chat messages. Each belongs to a conversation (direct or group).
  -- recipient_id is legacy (used only by old 1:1 rows) — nullable, no FK — because
  -- group messages have many recipients, tracked via chat_participants instead.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    conversation_id TEXT,
    sender_id TEXT NOT NULL,
    recipient_id TEXT,
    body TEXT,
    file_name TEXT,
    file_stored TEXT,
    file_type TEXT,
    file_size INTEGER,
    deleted_for_all INTEGER DEFAULT 0,
    reply_to TEXT,
    edited_at TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, recipient_id, created_at);

  -- "Delete for me": rows here hide a message from a single user's view only.
  -- (A message deleted for everyone is flagged on chat_messages.deleted_for_all.)
  CREATE TABLE IF NOT EXISTS chat_message_hidden (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Conversations: a 1:1 (direct) or multi-person (group) chat. Messages belong
  -- to a conversation; membership + per-user read position live in participants.
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'direct',     -- direct | group
    name TEXT,                                -- group name (null for direct)
    avatar_color TEXT DEFAULT '#6366f1',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_participants (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',      -- admin | member
    last_read_at TEXT,                         -- drives unread counts + read receipts
    joined_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_part_user ON chat_participants(user_id);

  -- Emoji reactions (one row per user+emoji on a message).
  CREATE TABLE IF NOT EXISTS chat_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );

  -- Starred / bookmarked messages (per user).
  CREATE TABLE IF NOT EXISTS chat_stars (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );

  -- @mentions inside a chat message. Stored as rows rather than parsed back out
  -- of the body on read: the body keeps the plain "@Reddeppa" the sender typed,
  -- and two people can share a first name, so the id captured at send time is
  -- the only record of WHICH teammate was meant. Drives the mention highlight,
  -- the mention notification, and the assignee VoTask pre-fills when a message
  -- becomes a task.
  CREATE TABLE IF NOT EXISTS chat_mentions (
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions(user_id, created_at);

  -- Audio / video calls. The media itself never touches this server — it is
  -- peer-to-peer WebRTC, negotiated over the chat WebSocket. What lives here is
  -- the call's LEDGER: who rang whom, when it was answered, how long it ran. That
  -- is what puts a "Video call · 4m" line in the thread and what lets the app
  -- turn a call into tasks afterwards.
  CREATE TABLE IF NOT EXISTS chat_calls (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    started_by TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- audio | video
    status TEXT NOT NULL,                -- ringing | active | ended | missed | declined
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_calls_convo ON chat_calls(conversation_id, started_at);

  -- Live transcript of a call, one row per utterance, contributed by each
  -- participant's OWN browser as they speak.
  --
  -- This is how a call becomes tasks without any speech-provider key: the Web
  -- Speech API can only hear the microphone of the device it runs on, so instead
  -- of one machine trying (and failing) to transcribe everybody, every machine
  -- transcribes its owner and the server stitches the pieces back together in
  -- time order. It is not a workaround — the result is BETTER than transcribing
  -- one mixed audio file, because every line arrives already attributed to the
  -- person who said it, which is exactly what task extraction needs.
  CREATE TABLE IF NOT EXISTS chat_call_segments (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (call_id) REFERENCES chat_calls(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_call_segments ON chat_call_segments(call_id, created_at);

  -- Who actually joined a call, so a group call can report "3 joined" rather than
  -- "everyone was invited". left_at NULL = still in.
  CREATE TABLE IF NOT EXISTS chat_call_participants (
    call_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT,
    left_at TEXT,
    PRIMARY KEY (call_id, user_id),
    FOREIGN KEY (call_id) REFERENCES chat_calls(id) ON DELETE CASCADE
  );

  -- "Remind me about this message at 4pm." Per-user, so two people can set their
  -- own reminder on the same message without seeing each other's.
  CREATE TABLE IF NOT EXISTS chat_reminders (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message_id TEXT,
    conversation_id TEXT NOT NULL,
    note TEXT DEFAULT '',
    remind_at TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_reminders_due ON chat_reminders(sent, remind_at);

  -- A message written now and delivered later. It is NOT a chat_messages row
  -- until it sends — otherwise it would show in the thread, count as unread and
  -- be searchable before anyone was meant to see it.
  CREATE TABLE IF NOT EXISTS chat_scheduled (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    body TEXT NOT NULL,
    mentions TEXT DEFAULT '',            -- comma-separated user ids, resolved at send time
    send_at TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_scheduled_due ON chat_scheduled(sent, send_at);

  -- A poll posted in a chat (WhatsApp's). The question is the message body; the
  -- options are fixed once posted, because a vote is a vote FOR a particular
  -- wording and editing an option under people's votes would change what they
  -- said. One row per vote rather than a JSON blob, so two people voting at
  -- the same moment cannot overwrite each other.
  CREATE TABLE IF NOT EXISTS chat_polls (
    message_id TEXT PRIMARY KEY,
    options TEXT NOT NULL,               -- JSON array of option labels, in order
    multi INTEGER DEFAULT 0,             -- 1 = people may pick more than one
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS chat_poll_votes (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    option_idx INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, option_idx),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );

  -- A person's daily metrics card in one chat (routes/dailyUpdates.js): the
  -- message they post every day, with blanks, set up once and then only filled
  -- in. body is that message (added by migration, see daily_metrics_text_v1);
  -- metrics is the old list-of-numbers form, kept only so the column stays
  -- NOT NULL-valid. remind_at is "HH:MM" in TASK_MAIL_TZ, remind_days
  -- the weekdays it applies to (0 = Sunday). The two dates let the reminder
  -- sweep skip, by row, whoever has posted or been reminded today.
  CREATE TABLE IF NOT EXISTS daily_update_templates (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    metrics TEXT NOT NULL,
    remind_at TEXT,
    remind_days TEXT DEFAULT '1,2,3,4,5,6',
    last_posted_date TEXT,
    last_reminded_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, conversation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dut_conv ON daily_update_templates(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_dut_remind ON daily_update_templates(remind_at);
  -- A browser that turned on VoTask notifications (webPush.js): its Web Push
  -- endpoint and the keys its messages are encrypted with. One row per browser.
  CREATE TABLE IF NOT EXISTS web_push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    ua TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_web_push_user ON web_push_subs(user_id);

  -- One row per update posted, so "who has posted today" and "this month so
  -- far" are index lookups rather than a walk through the chat's messages.
  -- The card itself is the chat message (kind 'update', its numbers in meta).
  CREATE TABLE IF NOT EXISTS daily_update_posts (
    message_id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,                   -- YYYY-MM-DD in TASK_MAIL_TZ
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_dup_template ON daily_update_posts(template_id, day);
  CREATE INDEX IF NOT EXISTS idx_dup_conv_day ON daily_update_posts(conversation_id, day);

  -- Every time someone's delivered / read position in a conversation moves
  -- forward. chat_participants only holds where it is NOW; Message info has to
  -- say WHEN a particular message was read, which is the first of these at or
  -- after it was sent. One row per move, not per message, so a thread of a
  -- thousand messages read in one go costs one row.
  CREATE TABLE IF NOT EXISTS chat_receipt_marks (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- d = delivered | r = read
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_receipt_marks ON chat_receipt_marks(conversation_id, user_id, kind, at);

  -- Link previews, fetched once per address by the server and shared by every
  -- message that carries it. data is NULL when the page had nothing to show,
  -- which is remembered too so a dead link is not re-fetched on every render.
  CREATE TABLE IF NOT EXISTS chat_link_previews (
    url TEXT PRIMARY KEY,
    data TEXT,
    fetched_at TEXT NOT NULL
  );

  -- AI Assistant chat history. One row per conversation thread; messages is a
  -- JSON array of {role, text, tasks?}. Scoped to the owning user so threads
  -- follow the manager across devices/browsers.
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New chat',
    messages TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_convo_user ON conversations(user_id, updated_at);

  -- Meeting attendees. Only these users can be suggested as task owners.
  CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (meeting_id, user_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- AI Review Queue: tasks the AI proposes from a meeting, held for manager
  -- review BEFORE they become real (assigned) tasks. Kept separate from the
  -- tasks table so pending suggestions never leak into dashboards or task lists.
  CREATE TABLE IF NOT EXISTS suggested_tasks (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    suggested_assignee_id TEXT,                 -- resolved among attendees, may be null
    suggested_assignee_raw TEXT,                -- spoken name before matching
    assignee_reasoning TEXT,                    -- why the AI chose this person
    confidence INTEGER DEFAULT 50,              -- 0-100 confidence score
    priority TEXT DEFAULT 'Medium',
    due_date TEXT,
    due_date_raw TEXT,
    source_quote TEXT,                          -- exact transcript line
    status TEXT DEFAULT 'pending',              -- pending | approved | rejected | merged
    merged_into TEXT,                           -- suggestion id this was merged into
    created_task_id TEXT,                       -- the real task created on approval
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (suggested_assignee_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_suggested_meeting ON suggested_tasks(meeting_id, status);

  -- What the AI made of a meeting WHILE it was being recorded, a stretch at a
  -- time (ai/liveAnalysis.js), so the end of a five-hour meeting has only its
  -- last few minutes left to read. Belongs to the status='recording' draft row
  -- and goes with it. A cache: a stretch is reused only if its exact text is
  -- still in the transcript that is finally submitted.
  CREATE TABLE IF NOT EXISTS meeting_live_chunks (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    seq INTEGER NOT NULL,                       -- order analysed
    text TEXT NOT NULL,                         -- the transcript lines analysed, verbatim
    start_seconds INTEGER DEFAULT 0,            -- recording clock at either end
    end_seconds INTEGER DEFAULT 0,
    memory TEXT,                                -- running memory through this stretch
    notes_json TEXT,                            -- its summary, decisions, risks, blockers, follow-ups
    tasks_json TEXT,                            -- tasks found in it
    languages TEXT,
    engine TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_live_chunks_meeting ON meeting_live_chunks(meeting_id, seq);

  -- Team invitations: a manager invites a teammate by email; the invitee follows
  -- a tokenized link to set their own password and join the org with the given role.
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    department_id TEXT,
    token TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | revoked
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id, status);
  CREATE INDEX IF NOT EXISTS idx_join_requests_org ON join_requests(org_id, status);
  -- One live request per person per org; a denied or approved one may be retried.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending
    ON join_requests(org_id, email) WHERE status = 'pending';

  -- Single-use, expiring tokens for "forgot password".
  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Single-use, expiring tokens that confirm a user owns their email address.
  -- LEGACY: these back the old emailed links. Nothing issues new ones (codes in
  -- email_codes replaced them); the table stays so links already sitting in
  -- inboxes still work until they expire.
  CREATE TABLE IF NOT EXISTS email_verifications (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- LEGACY / UNUSED. Held the old 0-100 daily-rating history. Leaderboard points
  -- are now a flat count of actions (assign / complete / comment / status change)
  -- counted live from tasks, task_comments and audit_logs on every read, so nothing
  -- writes or reads this table any more — see performance.js and scoring.js.
  -- Kept (empty) rather than dropped so an existing database needs no migration.
  CREATE TABLE IF NOT EXISTS performance_daily (
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    day TEXT NOT NULL,                         -- YYYY-MM-DD (local server date)
    day_score REAL NOT NULL,                   -- 0-100
    rating_after REAL NOT NULL,                -- 0-1000 cumulative rating after this day
    tasks_done INTEGER NOT NULL DEFAULT 0,     -- tasks completed that day
    weighted REAL NOT NULL DEFAULT 0,          -- priority-weighted throughput that day
    on_time_rate REAL,                         -- 0-1, null if no due-dated completion
    quality_rate REAL,                         -- 0-1, null if nothing resolved
    engagement REAL NOT NULL DEFAULT 0,        -- 0-1
    penalty REAL NOT NULL DEFAULT 0,           -- points deducted for overdue work
    overdue_open INTEGER NOT NULL DEFAULT 0,   -- # open past-due tasks as of that day
    PRIMARY KEY (user_id, day),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_perf_org_day ON performance_daily(org_id, day);
  CREATE INDEX IF NOT EXISTS idx_perf_user_day ON performance_daily(user_id, day);

  -- In-app feedback: a star rating (1-5) + optional comment about the app itself.
  -- One current row per user (they update their own), so the org sees each
  -- member's latest opinion rather than a pile of duplicates.
  CREATE TABLE IF NOT EXISTS app_feedback (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE,
    rating INTEGER NOT NULL,                    -- 1..5 stars
    comment TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_org ON app_feedback(org_id);

  -- Every feedback SUBMISSION, append-only. app_feedback above holds each
  -- person's CURRENT opinion (one row, overwritten on re-submit); this is the
  -- trail behind it — who sent what, when, from which screen and which device,
  -- including every edit. Nothing here is ever updated or deleted, so a rating
  -- that changed from 2★ to 5★ still shows both steps.
  CREATE TABLE IF NOT EXISTS feedback_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    rating INTEGER NOT NULL,                    -- 1..5 stars as submitted
    comment TEXT,
    kind TEXT NOT NULL,                         -- 'new' (first time) | 'update'
    page TEXT,                                  -- route they were on, e.g. /tasks
    device TEXT,                                -- 'Android app', 'Chrome on Windows', …
    app_version TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_fbev_org ON feedback_events(org_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_fbev_user ON feedback_events(user_id);

  -- Long-lived API keys: how something that is not a browser reaches this API.
  -- A JWT comes from a password login and expires; an agent, a script or a CI job
  -- has no password to type and no session to refresh, so it carries one of these.
  --
  -- A key IS a user: it inherits the role and org of whoever minted it and can do
  -- no more than they can. That is the whole permission model — there are no key
  -- scopes, because a half-understood scope system reads as a safety guarantee it
  -- does not provide. Give a key to a tool you would give your own login to.
  --
  -- Only the SHA-256 of the token is stored. The plaintext is shown once, at
  -- creation, and is unrecoverable afterwards; the prefix column exists so a key
  -- can be recognized in a list without being able to reconstruct it.
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,                   -- the key acts as this user
    name TEXT NOT NULL,                      -- "Claude Code on my laptop"
    prefix TEXT NOT NULL,                    -- first few chars, for identification
    token_hash TEXT NOT NULL UNIQUE,         -- sha256(token), hex
    last_used_at TEXT,
    expires_at TEXT,                         -- null = no expiry
    revoked_at TEXT,                         -- set instead of deleting, so the
                                             -- audit trail keeps the whole story
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(token_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, revoked_at);

  -- Recycle bin. A deleted task is MOVED here rather than flagged in place.
  --
  -- The obvious design is a deleted_at column plus "AND deleted_at IS NULL" on
  -- every read. There are ~70 places that query tasks — dashboards, the digest,
  -- the leaderboard, RAG indexing, the voice agent's snapshot — and missing one
  -- means a deleted task quietly reappears in someone's numbers. Moving the row
  -- out makes that impossible: it is not in the table, so nothing can find it,
  -- and not one existing query has to change.
  --
  -- The cost is that restore must put back what the FK cascade took with it, so
  -- the payload column snapshots the task, its subtasks, comments, attachments
  -- and dependencies as JSON. Attachment FILES stay on disk until the purge —
  -- that is the one place where deleting early would make "recoverable" a lie.
  CREATE TABLE IF NOT EXISTS deleted_tasks (
    id TEXT PRIMARY KEY,                     -- the original task id; restore is idempotent
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,                     -- listed without parsing the payload
    assignee_name TEXT,
    deleted_by TEXT NOT NULL,
    deleted_by_name TEXT,
    deleted_at TEXT NOT NULL,
    purge_after TEXT NOT NULL,               -- deleted_at + RECOVERY_DAYS
    payload TEXT NOT NULL                    -- JSON snapshot; see restore in routes/tasks.js
  );
  CREATE INDEX IF NOT EXISTS idx_deleted_tasks_org ON deleted_tasks(org_id, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_deleted_tasks_purge ON deleted_tasks(purge_after);
  -- Task categories an org added itself (the five built-in brands live in
  -- categories.js). One row per org and name; the name is what a task stores in
  -- its category column, so renaming is deliberately not offered.
  CREATE TABLE IF NOT EXISTS task_categories (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,                              -- picked server-side so every screen agrees
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_categories_org ON task_categories(org_id);

  -- Six-digit email confirmation codes (see emailCodes.js). user_id set = someone
  -- confirming their own address; NULL = a manager confirming one before the
  -- account exists, which is why the address is stored rather than read off a
  -- user row. created_by is not a foreign key: removing the manager who asked
  -- for a code shouldn't be blocked by it.
  CREATE TABLE IF NOT EXISTS email_codes (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    proof TEXT,                              -- handed back on a manager-scope match
    expires_at TEXT NOT NULL,
    verified_at TEXT,
    used_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at);
  `)

  // Lightweight migrations: add columns to existing DBs that predate them.
  // Section-based engagement scoring: a JSON map of {section: {raw, capped, cap}}
  // for the day, so the leaderboard can explain WHY a score is what it is. The
  // legacy rating/on_time/quality/engagement/penalty columns predate this model
  // and are no longer written (they stay for old rows / backwards reads).
  ensureColumn('performance_daily', 'breakdown', 'TEXT')
  // Marks a workspace as a solo/personal account (org of one) vs a team company.
  // Existing orgs default to 0 (company) — no change to the org structure.
  ensureColumn('organizations', 'is_personal', 'INTEGER DEFAULT 0')
  // Platform (super) admin — can oversee ALL organizations. Granted via the
  // PLATFORM_ADMIN_EMAILS env var (synced on login). Default 0 for everyone.
  ensureColumn('users', 'platform_admin', 'INTEGER DEFAULT 0')
  // Per-org allowed email domains (comma-separated). NULL/empty = no restriction.
  ensureColumn('organizations', 'allowed_domains', 'TEXT')
  // Lets the super admin grant an org's own admins access to view their usage.
  ensureColumn('organizations', 'usage_access', 'INTEGER DEFAULT 0')
  // Admin-chosen leaderboard window (the "Custom" period): inclusive UTC
  // yyyy-mm-dd bounds. Both NULL = no custom range, everyone gets the calendar
  // month default. Set/cleared by managers via PUT /api/scores/range.
  ensureColumn('organizations', 'leaderboard_from', 'TEXT')
  ensureColumn('organizations', 'leaderboard_to', 'TEXT')

  // Shareable join link / org code. Off by default: switching it on is a
  // deliberate act, because it opens a second door into an org that until now
  // could only be entered by per-person invite.
  ensureColumn('organizations', 'join_code', 'TEXT')
  ensureColumn('organizations', 'join_enabled', 'INTEGER DEFAULT 0')
  ensureColumn('organizations', 'join_role', "TEXT DEFAULT 'employee'")
  ensureColumn('organizations', 'join_expires_at', 'TEXT')
  // Created AFTER the ensureColumn calls above, or a database predating those
  // columns fails to boot on this line.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_org_join_code ON organizations(join_code) WHERE join_code IS NOT NULL;")
  ensureColumn('users', 'email_verified', 'INTEGER DEFAULT 0')
  // Feedback prompt tags — the chips picked under "What do you like most?" (4-5★)
  // or "What could we improve?" (1-3★). A JSON array of labels, NULL when none
  // were picked. Stored on both the current opinion and every event behind it,
  // so a rating that moved from 2★ to 5★ keeps what was said at each step.
  // Which notifications this person wants. JSON object keyed by category
  // (tasks/chat/deadlines/approvals); NULL means "never chose", which reads as
  // everything on — the behaviour before the setting existed.
  ensureColumn('users', 'notif_prefs', 'TEXT')
  ensureColumn('app_feedback', 'tags', 'TEXT')
  ensureColumn('feedback_events', 'tags', 'TEXT')
  // Google account link: the Google user id ("sub") for accounts that have signed
  // in with Google at least once. NULL for password-only accounts. Sign-in matches
  // on email first (login-only — we never create accounts from Google), then stamps
  // this so the link is explicit for future logins.
  ensureColumn('users', 'google_id', 'TEXT')
  ensureColumn('tasks', 'assigned_at', 'TEXT')
  ensureColumn('tasks', 'submitted_at', 'TEXT')
  ensureColumn('tasks', 'completed_at', 'TEXT')
  ensureColumn('tasks', 'visible_to_manager', 'INTEGER DEFAULT 1')
  // Business-unit / brand category (DCAL, Rice, Global Shopper, 91GI, Taskmanager),
  // auto-detected from the task text. NULL = Uncategorized. See categories.js.
  ensureColumn('tasks', 'category', 'TEXT')
  ensureColumn('suggested_tasks', 'category', 'TEXT')
  // WHO ASSIGNED IT. Every extraction engine already works this out — the rule
  // engine from the speaker of the sentence, the LLMs from the conversation —
  // and `tasks` has carried assigned_by_name_raw all along. It was only the
  // suggestion queue that had nowhere to put it, so the answer was computed and
  // then dropped, and whoever happened to press Assign became the assigner.
  ensureColumn('suggested_tasks', 'suggested_assigner_id', 'TEXT')
  ensureColumn('suggested_tasks', 'suggested_assigner_raw', 'TEXT')
  // 'audio' | 'video' for a meeting that came from a call, so the review screen
  // can name what it is reviewing instead of calling everything a meeting.
  ensureColumn('meetings', 'call_kind', 'TEXT')
  // What an API key is allowed to be: 'full' is a REST credential sent in an
  // Authorization header; 'mcp' is a Claude connector key, which by necessity
  // travels inside a URL and is therefore refused everywhere except /mcp. If a
  // connector URL leaks out of a log, the finder gets the eight curated MCP
  // tools rather than the whole API.
  ensureColumn('api_keys', 'scope', "TEXT DEFAULT 'full'")
  // A comment that can be changed after the fact needs to say so, or the record
  // of who agreed to what silently stops being a record.
  ensureColumn('task_comments', 'edited_at', 'TEXT')
  // Reassignment trail. Changing assignee_id overwrites the previous owner in
  // place, so without these a reassigned task is indistinguishable from one that
  // was assigned directly, and the person it was taken from leaves no trace.
  // NULL on every existing row = "never reassigned", which is the honest answer
  // for tasks that predate this.
  ensureColumn('tasks', 'reassigned_at', 'TEXT')
  ensureColumn('tasks', 'reassigned_by_id', 'TEXT')   // who moved it
  ensureColumn('tasks', 'previous_assignee_id', 'TEXT') // who it was taken from
  // WHO CLOSED IT. completed_at said when a task was finished but not by whom,
  // and a task can be closed by its owner (tick, board drag, the assistant), a
  // manager, or an approver — so "who marked this done?" had no answer on screen.
  // Kept in step with completed_at: set and cleared at the same moments.
  ensureColumn('tasks', 'completed_by_id', 'TEXT')
  // The Tasks page's Activity view reads the audit log per org newest-first, and
  // looks up a task's own entries (its create row, its title once purged). The
  // table had no index at all, so both were full scans of every org's history.
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_logs(org_id, created_at);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, action);')
  // Recover the name for tasks closed before the column existed. The audit log
  // has always recorded the actor of every status move, approval and edit, so
  // the latest completing action on a task that is Done now is the one that
  // closed it — found in one ordered pass, later rows overwriting earlier ones.
  // A task with no such row (seed data, or a split parent that rolled itself
  // up) stays NULL, and the UI then names nobody rather than guessing.
  runOnce('tasks_completed_by_backfill_v1', () => {
    const rows = db.prepare(
      `SELECT entity_id, actor_id FROM audit_logs
       WHERE entity_type = 'task' AND actor_id IS NOT NULL AND (
         (action = 'task.status' AND detail = 'Done') OR
         (action = 'task.approval' AND detail = 'approved') OR
         (action IN ('task.update', 'task.reassign')
           AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.status') END = 'Done'))
       ORDER BY created_at`
    ).all()
    const closer = new Map()
    for (const r of rows) closer.set(r.entity_id, r.actor_id) // later rows win
    const set = db.prepare("UPDATE tasks SET completed_by_id=? WHERE id=? AND status='Done' AND completed_by_id IS NULL")
    let n = 0
    db.transaction(() => { for (const [tid, uid] of closer) n += set.run(uid, tid).changes })()
    if (n) console.log(`[migrate] named who completed ${n} finished task(s) from the audit log`)
  })

  // Task attachments: the original table only had `filename`. Enrich it to store
  // the on-disk name, mime type, size and org (mirrors the chat_messages file
  // model) so images/PDFs/videos attached to a task can be served + authorized.
  ensureColumn('attachments', 'org_id', 'TEXT')
  ensureColumn('attachments', 'stored_name', 'TEXT')   // generated name on disk (data/task_uploads)
  ensureColumn('attachments', 'file_type', 'TEXT')     // mime type
  ensureColumn('attachments', 'file_size', 'INTEGER')  // bytes
  ensureColumn('users', 'phone', "TEXT DEFAULT ''")
  ensureColumn('meetings', 'description', "TEXT DEFAULT ''")

  // Chat file attachments + "delete for everyone" flag.
  ensureColumn('chat_messages', 'file_name', 'TEXT')      // original filename shown to users
  ensureColumn('chat_messages', 'file_stored', 'TEXT')    // generated name on disk (data/chat_uploads)
  ensureColumn('chat_messages', 'file_type', 'TEXT')      // mime type
  ensureColumn('chat_messages', 'file_size', 'INTEGER')   // bytes
  ensureColumn('chat_messages', 'deleted_for_all', 'INTEGER DEFAULT 0')
  ensureColumn('chat_messages', 'conversation_id', 'TEXT') // owning conversation
  ensureColumn('chat_messages', 'reply_to', 'TEXT')        // message id being replied to
  ensureColumn('chat_messages', 'edited_at', 'TEXT')       // set when the body is edited
  ensureColumn('chat_participants', 'muted', 'INTEGER DEFAULT 0')  // per-user mute
  ensureColumn('chat_participants', 'pinned', 'INTEGER DEFAULT 0') // per-user pin-to-top
  ensureColumn('users', 'last_seen', 'TEXT')               // updated when a user's last socket disconnects
  ensureColumn('users', 'avatar_file', 'TEXT')             // uploaded profile photo (data/avatars)
  ensureColumn('chat_conversations', 'avatar_file', 'TEXT') // uploaded group photo
  // 'private' (default, invite-only) or 'public' (any colleague can find it and
  // join). Existing groups stay private on purpose: silently opening rooms people
  // created under an invite-only assumption would be a disclosure, not a feature.
  ensureColumn('chat_conversations', 'visibility', "TEXT DEFAULT 'private'")
  ensureColumn('chat_messages', 'forwarded', 'INTEGER DEFAULT 0') // message was forwarded
  // Pinning a MESSAGE (to the thread header) is a different thing from pinning a
  // CONVERSATION (to the top of your own list, chat_participants.pinned): a pinned
  // message is shared by everyone in the thread, which is why it lives here and
  // not per-participant.
  ensureColumn('chat_messages', 'pinned_at', 'TEXT')
  ensureColumn('chat_messages', 'pinned_by', 'TEXT')
  ensureColumn('chat_messages', 'call_id', 'TEXT')   // the call this line reports on
  // Cached transcription of a voice note. Cached rather than recomputed because
  // transcription is a paid call per request, and everyone in the thread would
  // otherwise pay for the same thirty seconds of audio.
  ensureColumn('chat_messages', 'transcript', 'TEXT')
  // The meeting a chat line reports on, so a finished call leaves its summary
  // where the conversation happened rather than only in the Meetings list.
  ensureColumn('chat_messages', 'meeting_id', 'TEXT')
  // Mute with an expiry ("for 8 hours"). The old boolean stays the source of
  // truth for "muted forever"; this column is what makes a timed mute wear off.
  ensureColumn('chat_participants', 'muted_until', 'TEXT')
  // Custom status + do-not-disturb, both Cliq staples. dnd_until is a timestamp
  // rather than a flag so "DND for 2 hours" ends by itself.
  ensureColumn('users', 'status_text', "TEXT DEFAULT ''")
  ensureColumn('users', 'status_emoji', "TEXT DEFAULT ''")
  ensureColumn('users', 'dnd_until', 'TEXT')
  ensureColumn('meetings', 'draft_seconds', 'INTEGER DEFAULT 0') // elapsed clock of an in-progress recording

  // ---- WhatsApp parity for chat ----
  // What a message IS when it is not plain text or a file: 'system' (a group
  // event line — "Priya added Ravi"), 'poll', 'task' (a task assigned from the
  // chat), 'location', 'contact'. NULL is an ordinary message. `meta` carries
  // the kind's own data as JSON (who did what to whom, coordinates, …).
  ensureColumn('chat_messages', 'kind', 'TEXT')
  ensureColumn('chat_messages', 'meta', 'TEXT')
  ensureColumn('chat_messages', 'task_id', 'TEXT')
  // The second tick. Moves forward when a message reaches any of the person's
  // devices — a live socket, or the app polling for unread counts.
  ensureColumn('chat_participants', 'last_delivered_at', 'TEXT')
  // The blue tick, kept apart from last_read_at on purpose: "Mark as unread"
  // rewinds last_read_at, and that must not take back a read receipt the
  // sender has already seen turn blue. This one only ever moves forward.
  ensureColumn('chat_participants', 'read_receipt_at', 'TEXT')
  ensureColumn('chat_participants', 'archived', 'INTEGER DEFAULT 0')
  ensureColumn('chat_participants', 'marked_unread', 'INTEGER DEFAULT 0')
  // "Delete chat": the conversation leaves your list until a message newer
  // than this arrives, the way WhatsApp brings a deleted chat back.
  ensureColumn('chat_participants', 'removed_at', 'TEXT')
  ensureColumn('chat_conversations', 'description', "TEXT DEFAULT ''")
  // Group setting "Send messages: only admins".
  ensureColumn('chat_conversations', 'admins_only', 'INTEGER DEFAULT 0')
  // Calls are transcribed for tasks unless someone in the call switches it off;
  // meeting_id/processed_at make turning a finished call into tasks happen once.
  ensureColumn('chat_calls', 'transcribe', 'INTEGER DEFAULT 1')
  ensureColumn('chat_calls', 'meeting_id', 'TEXT')
  ensureColumn('chat_calls', 'processed_at', 'TEXT')
  // Turning a ring down in a GROUP call does not end the call — the others may
  // still be talking — so the decline has to be remembered per person, or the
  // next "is anything ringing for me?" check (on reload, on waking a phone)
  // would ring them again for a call they already said no to.
  ensureColumn('chat_call_participants', 'declined_at', 'TEXT')
  // Phones whose app can ring natively (a full-screen incoming call). Only they
  // get the call as a silent data push; an older app would drop that push on
  // the floor, so it gets an ordinary "is calling you" notification instead.
  ensureColumn('device_tokens', 'call_ring', 'INTEGER DEFAULT 0')
  // chime: this build ships VoTask's own notification sound and its channel
  // (push.js). Older builds lack both and stay on the default-tone channel.
  ensureColumn('device_tokens', 'chime', 'INTEGER DEFAULT 0')
  // The app's versionCode, reported from 4.5 on, so an "update available"
  // push goes only to phones still on an older build (push.js sendUpdatePush).
  ensureColumn('device_tokens', 'app_build', 'INTEGER')
  // WHERE A MEETING CAME FROM. A meeting filed out of a chat — a call's
  // transcript, a recording posted in the thread — kept its only trail on the
  // chat side (chat_calls.meeting_id, the "Summary of …" card), so nothing on
  // the meeting said which chat or which call it was. The chat info panel lists
  // a conversation's calls with their summaries, so the link now lives on the
  // meeting and is written when the meeting is created. Both stay NULL for
  // meetings made on the Meetings page, which belong to no conversation. (The
  // kind of call, meetings.call_kind, is ensured further up.)
  ensureColumn('meetings', 'conversation_id', 'TEXT')
  ensureColumn('meetings', 'call_id', 'TEXT')
  // After the ensureColumn calls, or a database predating the columns fails to
  // boot on these lines.
  db.exec('CREATE INDEX IF NOT EXISTS idx_meetings_conversation ON meetings(conversation_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_meetings_call ON meetings(call_id)')
  // WHICH CHAT A NOTIFICATION IS ABOUT. A chat notification ("Abhiram: hi")
  // carried only task_id, which chat never sets, so tapping it could open
  // nothing more specific than the chat list. notify() now records the
  // conversation and the line; both stay NULL for task notifications.
  ensureColumn('notifications', 'conversation_id', 'TEXT')
  ensureColumn('notifications', 'message_id', 'TEXT')
  // The same for a task comment: "Ravi commented on …" named only the task, so
  // tapping it opened the drawer at the title with the comment out of sight at
  // the bottom. NULL for everything that is not a comment.
  ensureColumn('notifications', 'comment_id', 'TEXT')

  // Index on conversation_id — created here (not in the inline schema) so it runs
  // AFTER the column is ensured above; otherwise older DBs predating the column fail.
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_convo ON chat_messages(conversation_id, created_at);')

  // Seed the submission trail from feedback left BEFORE feedback_events existed,
  // so an early review doesn't read as "0 submissions". Screen and device are
  // genuinely unknown for these, so they stay NULL rather than being invented —
  // the row records the honest minimum: who, what rating, and when.
  runOnce('feedback_events_backfill_v1', () => {
    const rows = db.prepare('SELECT id, org_id, user_id, rating, comment, created_at FROM app_feedback').all()
    const ins = db.prepare(`INSERT INTO feedback_events
      (id, org_id, user_id, rating, comment, kind, page, device, app_version, created_at)
      VALUES (?,?,?,?,?,'new',NULL,NULL,NULL,?)`)
    db.transaction(() => { for (const f of rows) ins.run(`fbe_seed_${f.id}`, f.org_id, f.user_id, f.rating, f.comment, f.created_at) })()
  })

  // Rebuild chat_messages on older DBs where recipient_id was NOT NULL with a FK
  // (which blocks group messages). Recreates it nullable / FK-free, preserving rows.
  runOnce('chat_messages_rebuild_v2', () => {
    const cols = db.prepare('PRAGMA table_info(chat_messages)').all()
    const recip = cols.find((c) => c.name === 'recipient_id')
    if (!recip || recip.notnull === 0) return // already nullable — nothing to do
    db.pragma('foreign_keys = OFF')
    const rebuild = db.transaction(() => {
      db.exec(`CREATE TABLE chat_messages_new (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, conversation_id TEXT, sender_id TEXT NOT NULL,
        recipient_id TEXT, body TEXT, file_name TEXT, file_stored TEXT, file_type TEXT, file_size INTEGER,
        deleted_for_all INTEGER DEFAULT 0, reply_to TEXT, edited_at TEXT, read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE );`)
      db.exec(`INSERT INTO chat_messages_new (id,org_id,conversation_id,sender_id,recipient_id,body,file_name,file_stored,file_type,file_size,deleted_for_all,reply_to,edited_at,read,created_at)
        SELECT id,org_id,conversation_id,sender_id,recipient_id,body,file_name,file_stored,file_type,file_size,deleted_for_all,reply_to,edited_at,read,created_at FROM chat_messages;`)
      db.exec('DROP TABLE chat_messages;')
      db.exec('ALTER TABLE chat_messages_new RENAME TO chat_messages;')
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_convo ON chat_messages(conversation_id, created_at);')
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, recipient_id, created_at);')
    })
    rebuild()
    db.pragma('foreign_keys = ON')
    console.log('[migrate] rebuilt chat_messages (recipient_id now nullable for group support)')
  })

  // Backfill: turn legacy 1:1 messages (sender_id/recipient_id) into conversations.
  runOnce('chat_conversations_v1', () => {
    const legacy = db.prepare("SELECT id, sender_id, recipient_id, created_at FROM chat_messages WHERE conversation_id IS NULL AND recipient_id IS NOT NULL AND recipient_id != ''").all()
    const pairKey = (a, b) => [a, b].sort().join('|')
    const convoForPair = new Map()
    for (const m of legacy) {
      const key = pairKey(m.sender_id, m.recipient_id)
      let cid = convoForPair.get(key)
      if (!cid) {
        const u = db.prepare('SELECT org_id FROM users WHERE id=?').get(m.sender_id)
        if (!u) continue
        cid = id('cv')
        db.prepare('INSERT INTO chat_conversations (id, org_id, type, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(cid, u.org_id, 'direct', m.sender_id, m.created_at || now(), now())
        for (const uid of [m.sender_id, m.recipient_id]) {
          db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)')
            .run(cid, uid, 'member', now(), now())
        }
        convoForPair.set(key, cid)
      }
      db.prepare('UPDATE chat_messages SET conversation_id=? WHERE id=?').run(cid, m.id)
    }
    if (convoForPair.size) console.log(`[migrate] created ${convoForPair.size} direct conversation(s) from legacy chat messages`)
  })

  // One-time: the Manager is now the org admin. Remove any legacy standalone
  // admin account so it no longer exists in already-seeded databases.
  runOnce('remove_standalone_admin_v1', () => {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all()
    for (const a of admins) {
      // Detach references so the delete can't trip a foreign-key constraint.
      db.prepare('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?').run(a.id)
      db.prepare('DELETE FROM task_comments WHERE user_id=?').run(a.id)
      db.prepare('DELETE FROM users WHERE id=?').run(a.id)
    }
    if (admins.length) console.log(`[migrate] removed ${admins.length} legacy admin account(s) — the manager is now the admin`)
  })

  // One-time: switch the department set to IT / Marketing / Sales / Management.
  // Rename the legacy departments in place (keeps user assignments intact) and
  // ensure all four exist.
  runOnce('departments_it_mkt_sales_mgmt_v1', () => {
    for (const [oldName, newName] of [['Engineering', 'IT'], ['QA', 'Marketing'], ['DevOps', 'Sales']]) {
      db.prepare('UPDATE departments SET name=? WHERE name=?').run(newName, oldName)
    }
    for (const org of db.prepare('SELECT id FROM organizations').all()) {
      for (const name of ['IT', 'Marketing', 'Sales', 'Management']) {
        const exists = db.prepare('SELECT id FROM departments WHERE org_id=? AND name=?').get(org.id, name)
        if (!exists) db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(id('dep'), org.id, name)
      }
    }
  })

  // Link the meetings filed before meetings.conversation_id / call_id existed,
  // where the answer is a fact and not a guess:
  //  1. A call summarised at hang-up names its meeting (chat_calls.meeting_id):
  //     exact on both counts.
  //  2. A "Summary of …" card, or a recording that was turned into a meeting,
  //     names its meeting AND sits in a conversation. Oldest first, so the chat
  //     a meeting was first filed in is the one it keeps.
  //  3. Older call meetings recorded nothing about their call, so they are
  //     matched by TIME: a call their filer was on, running when the meeting was
  //     created (two minutes of grace after the end, for the hang-up path).
  //     Back-to-back calls make that ambiguous, and a wrong link would file one
  //     call's summary under another, so it links only when exactly one call
  //     fits and leaves the rest alone. That is also why this is a one-time
  //     backfill and not how links are made: new meetings carry theirs from the
  //     moment they are created.
  // julianday() rather than comparing strings: chat_calls holds ISO timestamps
  // ('2026-09-30T06:44:46.490Z') and some in SQLite's own format ('2026-09-29
  // 08:35:17'), and 'T' > ' ' makes a string BETWEEN wrong across the two.
  runOnce('meetings_chat_link_v1', () => {
    try {
      let byCall = 0, byCard = 0, byTime = 0
      db.transaction(() => {
        const kindOf = (k) => (k === 'video' ? 'video' : 'audio')
        const setCall = db.prepare(`UPDATE meetings
          SET call_id=?, conversation_id=COALESCE(conversation_id, ?), call_kind=COALESCE(call_kind, ?)
          WHERE id=? AND org_id=? AND call_id IS NULL`)
        for (const k of db.prepare('SELECT id, org_id, conversation_id, kind, meeting_id FROM chat_calls WHERE meeting_id IS NOT NULL').all()) {
          byCall += setCall.run(k.id, k.conversation_id, kindOf(k.kind), k.meeting_id, k.org_id).changes
        }

        const cards = db.prepare(`SELECT meeting_id, conversation_id FROM chat_messages
          WHERE meeting_id IS NOT NULL AND conversation_id IS NOT NULL ORDER BY julianday(created_at)`).all()
        const setConversation = db.prepare(`UPDATE meetings SET conversation_id=?
          WHERE id=? AND conversation_id IS NULL AND org_id=(SELECT org_id FROM chat_conversations WHERE id=?)`)
        for (const c of cards) byCard += setConversation.run(c.conversation_id, c.meeting_id, c.conversation_id).changes

        const callsAround = db.prepare(`
          SELECT k.id, k.conversation_id, k.kind FROM chat_calls k
          JOIN chat_call_participants p ON p.call_id=k.id AND p.user_id=?
          WHERE k.org_id=? AND (? IS NULL OR k.conversation_id=?)
            AND julianday(?) BETWEEN julianday(k.started_at)
                                 AND julianday(COALESCE(k.ended_at, ?)) + 120.0/86400`)
        const unlinked = db.prepare(`SELECT id, org_id, uploaded_by, conversation_id, created_at FROM meetings
          WHERE source_type='call' AND call_id IS NULL AND status<>'recording'`).all()
        for (const m of unlinked) {
          if (!m.uploaded_by) continue
          const hits = callsAround.all(m.uploaded_by, m.org_id, m.conversation_id, m.conversation_id, m.created_at, m.created_at)
          if (hits.length !== 1) continue
          byTime += setCall.run(hits[0].id, hits[0].conversation_id, kindOf(hits[0].kind), m.id, m.org_id).changes
        }
      })()
      if (byCall || byCard || byTime) console.log(`[migrate] linked meetings to their chat: ${byCall} by call, ${byCard} by summary card, ${byTime} by call time`)
    } catch (e) {
      // Never block boot on this. Every meeting created from now on is linked
      // when it is made; an old one left unlinked is only missing from its
      // chat's meeting list.
      console.error('[migrate] meetings_chat_link_v1 skipped:', e.message)
    }
  })

  // Point the chat notifications already in people's bells at their chat, so
  // the fix is not only for messages sent after it. notify() ran in the same
  // request as the message, straight after inserting it, so the line is the
  // nearest one before the notification that the named person sent into a chat
  // the reader is in — and, for plain text, the one whose words the
  // notification quotes. Nearest, not "the only one": a call ending files its
  // line and a "declined" line from the same caller within milliseconds.
  // Anything that does not fit keeps opening the chat list, as every chat
  // notification did before. Reactions are left alone: they name the reactor
  // but point at the reader's own older line.
  runOnce('notifications_chat_link_v1', () => {
    try {
      let linked = 0
      db.transaction(() => {
        const rows = db.prepare(`SELECT id, user_id, type, message, created_at FROM notifications
          WHERE conversation_id IS NULL AND type IN ('chat_message','chat_mention','chat_call')`).all()
        const before = db.prepare(`
          SELECT m.id, m.conversation_id, m.call_id, m.body, m.kind, m.file_name, m.meeting_id, u.name FROM chat_messages m
          JOIN chat_participants p ON p.conversation_id=m.conversation_id AND p.user_id=?
          JOIN users u ON u.id=m.sender_id
          WHERE m.created_at BETWEEN ? AND ? AND m.sender_id<>?
          ORDER BY m.created_at DESC`)
        const set = db.prepare('UPDATE notifications SET conversation_id=?, message_id=? WHERE id=?')
        const fits = (n, m) => {
          const text = n.message || ''
          if (n.type === 'chat_call') {
            const said = /^Missed (\w+) call from (.+)$/.exec(text)
            return !!said && !!m.call_id && said[2] === m.name && String(m.body || '').toLowerCase().startsWith(said[1])
          }
          const named = n.type === 'chat_mention'
            ? text.startsWith(`${m.name} mentioned you`)
            : !text.startsWith(`${m.name} reacted `) &&
              (text.startsWith(`${m.name}: `) || text.startsWith(`${m.name} in `) || text.startsWith(`${m.name} started "`))
          if (!named) return false
          // Plain text is quoted in the notification; anything else (a photo,
          // a poll) is a fixed label, so the name and the timing have to do.
          const plain = m.body && !m.kind && !m.file_name && !m.meeting_id && !m.call_id
          return !plain || text.includes(m.body.trim().slice(0, 20)) || text.includes(' started "')
        }
        for (const n of rows) {
          const t = Date.parse(n.created_at)
          if (!Number.isFinite(t)) continue
          const hit = before.all(n.user_id, new Date(t - 10000).toISOString(), n.created_at, n.user_id).find((m) => fits(n, m))
          if (!hit) continue
          set.run(hit.conversation_id, hit.id, n.id)
          linked++
        }
      })()
      if (linked) console.log(`[migrate] linked ${linked} chat notifications to their message`)
    } catch (e) {
      // Never block boot on this: an old notification left unlinked still
      // opens the chat list, which is all it ever did.
      console.error('[migrate] notifications_chat_link_v1 skipped:', e.message)
    }
  })

  // Point the comment notifications already in people's bells at their comment.
  // notify() ran in the same request, straight after the comment was inserted,
  // so it is the nearest comment on that task, a moment before, by the person
  // the notification names. Of several, the one whose words it quotes (the
  // quote is the original text, so an edited comment is matched on name alone).
  // A comment since deleted is simply not found; that notification keeps
  // opening the task, as it always did.
  runOnce('notifications_comment_link_v1', () => {
    try {
      let linked = 0
      db.transaction(() => {
        const rows = db.prepare(`SELECT id, user_id, task_id, message, created_at FROM notifications
          WHERE type='task_comment' AND comment_id IS NULL AND task_id IS NOT NULL`).all()
        const before = db.prepare(`
          SELECT c.id, c.body, u.name FROM task_comments c JOIN users u ON u.id=c.user_id
          WHERE c.task_id=? AND c.created_at BETWEEN ? AND ? AND c.user_id<>?
          ORDER BY c.created_at DESC`)
        const set = db.prepare('UPDATE notifications SET comment_id=? WHERE id=?')
        for (const n of rows) {
          const t = Date.parse(n.created_at)
          if (!Number.isFinite(t)) continue
          const text = n.message || ''
          const named = before.all(n.task_id, new Date(t - 10000).toISOString(), n.created_at, n.user_id)
            .filter((c) => text.startsWith(`${c.name} commented on `))
          const hit = named.find((c) => text.includes(String(c.body).slice(0, 20))) || named[0]
          if (!hit) continue
          set.run(hit.id, n.id)
          linked++
        }
      })()
      if (linked) console.log(`[migrate] linked ${linked} comment notifications to their comment`)
    } catch (e) {
      // Never block boot on this: an unlinked one still opens the task.
      console.error('[migrate] notifications_comment_link_v1 skipped:', e.message)
    }
  })

  // Daily metrics cards became the person's own message with blanks (body),
  // replacing the list of numbers the app added up. A card made the old way
  // turns into one "Label (target) = ___" line per number it had.
  ensureColumn('daily_update_templates', 'body', "TEXT NOT NULL DEFAULT ''")
  runOnce('daily_metrics_text_v1', () => {
    try {
      const short = (n) => (n >= 1e7 ? `${+(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `${+(n / 1e5).toFixed(2)}L` : n >= 1e3 ? `${+(n / 1e3).toFixed(2)}k` : String(n))
      const rows = db.prepare("SELECT id, metrics FROM daily_update_templates WHERE body = ''").all()
      const set = db.prepare('UPDATE daily_update_templates SET body=? WHERE id=?')
      for (const t of rows) {
        let ms = []
        try { ms = JSON.parse(t.metrics || '[]') } catch {}
        const lines = ms.map((m) => `${m.label}${m.target ? ` (${short(m.target)}${m.stretch ? '-' + short(m.stretch) : ''})` : ''} = ___`)
        set.run(lines.length ? lines.join('\n') : 'Today = ___', t.id)
      }
    } catch (e) {
      console.error('[migrate] daily_metrics_text_v1 skipped:', e.message)
    }
  })

  // Indexes for lookups that run per row of a list, or on every save. Without
  // them each lookup was a full table scan, so a list of N tasks cost N scans
  // of the whole table — GET /tasks for 5,000 tasks took 5.6 s, and with one
  // Node thread every other user waited behind it. Last in initSchema on
  // purpose: every column named here exists by now, on a fresh DB or an old one.
  // The two on embeddings let the RAG sync compare hashes and the search worker
  // pick up changes without reading the 6 KB vector of every row (the table is
  // most of the database, far bigger than the server's memory).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_on ON task_dependencies(depends_on_task_id);
    CREATE INDEX IF NOT EXISTS idx_segments_meeting ON transcript_segments(meeting_id, seq);
    CREATE INDEX IF NOT EXISTS idx_meeting_part_user ON meeting_participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_notif_user_time ON notifications(user_id, created_at);
    -- Covering for chat.js deliverPending (run on every unread poll): "anything
    -- from someone else since my last delivery?" is answered from the index
    -- instead of reading each message row to see who sent it.
    CREATE INDEX IF NOT EXISTS idx_chat_convo_sender ON chat_messages(conversation_id, created_at, sender_id);
    CREATE INDEX IF NOT EXISTS idx_emb_hash ON embeddings(source_type, source_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_emb_updated ON embeddings(updated_at);
  `)
}

// Run a migration body exactly once, tracked by a key in app_meta.
function runOnce(key, fn) {
  const seen = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)
  if (seen) return
  fn()
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, '1')
}

// Add a column only if it doesn't already exist (SQLite has no IF NOT EXISTS for columns).
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
  }
}

export default db
