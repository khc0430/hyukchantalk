const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10 * 1024 * 1024
});

// ── 업로드 디렉토리 ──────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const safe = Date.now() + '_' + Math.random().toString(36).slice(2);
    cb(null, safe + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── 인메모리 DB ──────────────────────────────────────────────
let users        = {};   // { username: { password, profileImg, bio, createdAt } }
let sessions     = {};   // { socketId: username }
let onlineUsers  = {};   // { username: socketId }
let posts        = [];   // [ { id, author, text, img, likes[], comments[], createdAt } ]
let allChat      = [];   // [ { id, author, text, file, replyTo, reactions, createdAt } ]
let channels     = { '이치고-분대': [], '아이젠-토론': [], '호로-구역': [] };
// channels[name] = [ msg... ]
let dmRooms      = {};   // { roomKey: [ msg... ] }
let stories      = [];   // [ { id, author, text, img, createdAt } ]
let postIdSeq    = 1;
let msgIdSeq     = 1;
let storyIdSeq   = 1;

// KST 타임스탬프
function kstNow() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}
function dmKey(a, b) {
  return [a, b].sort().join('::');
}

// ── 정적 파일 & API ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 파일 업로드 (채팅용)
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype
  });
});

// 프로필 이미지 업로드
app.post('/upload-profile', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// 게시글 이미지 업로드
app.post('/upload-post', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// 스토리 만료 정리 (1분마다)
setInterval(() => {
  const now = Date.now();
  stories = stories.filter(s => now - new Date(s.createdAt).getTime() < 24 * 3600 * 1000);
  io.emit('stories_update', stories);
}, 60 * 1000);

// ── 소켓 ─────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── 회원가입 ──
  socket.on('register', ({ username, password }, cb) => {
    if (!username || !password) return cb({ ok: false, msg: '빈 칸이 있어.' });
    if (users[username]) return cb({ ok: false, msg: '이미 있는 사신이야.' });
    users[username] = { password, profileImg: '', bio: '', createdAt: kstNow() };
    cb({ ok: true, isNew: true });
  });

  // ── 로그인 ──
  socket.on('login', ({ username, password }, cb) => {
    const u = users[username];
    if (!u) return cb({ ok: false, msg: '없는 사신이야.' });
    if (u.password !== password) return cb({ ok: false, msg: '영압 인증 실패.' });
    sessions[socket.id] = username;
    onlineUsers[username] = socket.id;
    socket.username = username;
    io.emit('online_update', Object.keys(onlineUsers));
    cb({
      ok: true,
      username,
      profile: u,
      posts,
      allChat,
      channels: Object.keys(channels),
      stories,
      users: Object.keys(users).map(n => ({
        username: n,
        profileImg: users[n].profileImg,
        bio: users[n].bio
      }))
    });
  });

  // ── 프로필 수정 ──
  socket.on('update_profile', ({ bio, profileImg }, cb) => {
    const me = socket.username;
    if (!me || !users[me]) return cb && cb({ ok: false });
    if (bio !== undefined) users[me].bio = bio;
    if (profileImg !== undefined) users[me].profileImg = profileImg;
    io.emit('profile_updated', {
      username: me,
      bio: users[me].bio,
      profileImg: users[me].profileImg
    });
    cb && cb({ ok: true });
  });

  // ── 게시글 작성 ──
  socket.on('post_create', ({ text, img }, cb) => {
    const me = socket.username;
    if (!me) return;
    const post = {
      id: postIdSeq++,
      author: me,
      text,
      img: img || null,
      likes: [],
      comments: [],
      createdAt: kstNow()
    };
    posts.unshift(post);
    io.emit('post_new', post);
    cb && cb({ ok: true });
  });

  // ── 게시글 좋아요(영압 공명) ──
  socket.on('post_like', ({ postId }) => {
    const me = socket.username;
    const post = posts.find(p => p.id === postId);
    if (!post || !me) return;
    const idx = post.likes.indexOf(me);
    if (idx === -1) post.likes.push(me);
    else post.likes.splice(idx, 1);
    io.emit('post_like_update', { postId, likes: post.likes });
  });

  // ── 댓글/대댓글(귀도술) ──
  socket.on('post_comment', ({ postId, text, parentId }) => {
    const me = socket.username;
    const post = posts.find(p => p.id === postId);
    if (!post || !me || !text) return;
    const comment = {
      id: msgIdSeq++,
      author: me,
      text,
      parentId: parentId || null,
      likes: [],
      createdAt: kstNow()
    };
    post.comments.push(comment);
    io.emit('post_comment_new', { postId, comment });
  });

  // ── 스토리(잔향) 작성 ──
  socket.on('story_create', ({ text, img }, cb) => {
    const me = socket.username;
    if (!me) return;
    const story = {
      id: storyIdSeq++,
      author: me,
      text,
      img: img || null,
      createdAt: new Date().toISOString()
    };
    stories.push(story);
    io.emit('stories_update', stories);
    cb && cb({ ok: true });
  });

  // ── 전체 채팅(소울 광장) ──
  socket.on('all_chat_send', ({ text, file, replyTo }) => {
    const me = socket.username;
    if (!me) return;
    const msg = {
      id: msgIdSeq++,
      author: me,
      text: text || '',
      file: file || null,
      replyTo: replyTo || null,
      reactions: {},
      createdAt: kstNow()
    };
    allChat.push(msg);
    if (allChat.length > 500) allChat.shift();
    io.emit('all_chat_msg', msg);
  });

  // ── 채널 채팅 ──
  socket.on('channel_send', ({ channel, text, file, replyTo }) => {
    const me = socket.username;
    if (!me || !channels[channel]) return;
    const msg = {
      id: msgIdSeq++,
      author: me,
      text: text || '',
      file: file || null,
      replyTo: replyTo || null,
      reactions: {},
      createdAt: kstNow()
    };
    channels[channel].push(msg);
    if (channels[channel].length > 500) channels[channel].shift();
    io.emit('channel_msg', { channel, msg });
  });

  // ── 채널 생성 ──
  socket.on('channel_create', ({ name }, cb) => {
    if (!name || channels[name]) return cb && cb({ ok: false, msg: '이미 있거나 이름 없음' });
    channels[name] = [];
    io.emit('channel_list_update', Object.keys(channels));
    cb && cb({ ok: true });
  });

  // ── 채널 메시지 조회 ──
  socket.on('channel_history', ({ channel }, cb) => {
    cb && cb(channels[channel] || []);
  });

  // ── 메시지 리액션 ──
  socket.on('msg_react', ({ scope, channel, msgId, emoji }) => {
    // scope: 'all' | 'channel' | 'dm'
    const me = socket.username;
    if (!me) return;
    let msg;
    if (scope === 'all') msg = allChat.find(m => m.id === msgId);
    else if (scope === 'channel' && channel) msg = (channels[channel] || []).find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(me);
    if (idx === -1) msg.reactions[emoji].push(me);
    else msg.reactions[emoji].splice(idx, 1);
    if (scope === 'all') io.emit('all_chat_react', { msgId, reactions: msg.reactions });
    else io.emit('channel_react', { channel, msgId, reactions: msg.reactions });
  });

  // ── DM 리액션 ──
  socket.on('dm_react', ({ roomKey, msgId, emoji }) => {
    const me = socket.username;
    if (!me) return;
    const room = dmRooms[roomKey];
    if (!room) return;
    const msg = room.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(me);
    if (idx === -1) msg.reactions[emoji].push(me);
    else msg.reactions[emoji].splice(idx, 1);
    const partners = roomKey.split('::');
    partners.forEach(u => {
      if (onlineUsers[u]) io.to(onlineUsers[u]).emit('dm_react_update', { roomKey, msgId, reactions: msg.reactions });
    });
  });

  // ── 입력 중 이벤트 ──
  socket.on('typing', ({ scope, channel, to }) => {
    const me = socket.username;
    if (!me) return;
    if (scope === 'all') socket.broadcast.emit('typing_all', { username: me });
    else if (scope === 'channel') socket.broadcast.emit('typing_channel', { username: me, channel });
    else if (scope === 'dm' && to && onlineUsers[to]) {
      io.to(onlineUsers[to]).emit('typing_dm', { username: me });
    }
  });

  // ── DM 보내기 ──
  socket.on('dm_send', ({ to, text, file, replyTo }) => {
    const me = socket.username;
    if (!me || !to) return;
    const key = dmKey(me, to);
    if (!dmRooms[key]) dmRooms[key] = [];
    const msg = {
      id: msgIdSeq++,
      author: me,
      text: text || '',
      file: file || null,
      replyTo: replyTo || null,
      read: false,
      reactions: {},
      createdAt: kstNow()
    };
    dmRooms[key].push(msg);
    if (dmRooms[key].length > 500) dmRooms[key].shift();
    // 보낸 사람
    socket.emit('dm_msg', { roomKey: key, msg });
    // 받는 사람 (온라인이면)
    if (onlineUsers[to]) io.to(onlineUsers[to]).emit('dm_msg', { roomKey: key, msg });
  });

  // ── DM 기록 요청 ──
  socket.on('dm_history', ({ to }, cb) => {
    const me = socket.username;
    if (!me || !to) return cb && cb([]);
    const key = dmKey(me, to);
    // 읽음 처리
    (dmRooms[key] || []).forEach(m => { if (m.author !== me) m.read = true; });
    cb && cb(dmRooms[key] || []);
    // 상대에게 읽음 알림
    if (onlineUsers[to]) io.to(onlineUsers[to]).emit('dm_read', { roomKey: key });
  });

  // ── DM 읽음 처리 ──
  socket.on('dm_seen', ({ to }) => {
    const me = socket.username;
    if (!me || !to) return;
    const key = dmKey(me, to);
    (dmRooms[key] || []).forEach(m => { if (m.author !== me) m.read = true; });
    if (onlineUsers[to]) io.to(onlineUsers[to]).emit('dm_read', { roomKey: key });
  });

  // ── 프로필 모달 데이터 요청 ──
  socket.on('get_profile', ({ username }, cb) => {
    const u = users[username];
    if (!u) return cb && cb(null);
    const userPosts = posts.filter(p => p.author === username);
    cb && cb({
      username,
      profileImg: u.profileImg,
      bio: u.bio,
      posts: userPosts,
      online: !!onlineUsers[username]
    });
  });

  // ── 방명록 ──
  socket.on('guestbook_write', ({ targetUser, text }, cb) => {
    const me = socket.username;
    if (!me || !targetUser || !users[targetUser] || !text) return cb && cb({ ok: false });
    const comment = {
      id: msgIdSeq++,
      author: me,
      text,
      parentId: null,
      likes: [],
      createdAt: kstNow()
    };
    // 방명록은 게시글처럼 별도 저장 — targetUser 필드에 저장
    if (!users[targetUser].guestbook) users[targetUser].guestbook = [];
    users[targetUser].guestbook.push(comment);
    // 대상 온라인이면 실시간 알림
    if (onlineUsers[targetUser]) io.to(onlineUsers[targetUser]).emit('guestbook_new', { author: me, text });
    cb && cb({ ok: true, comment });
  });

  socket.on('get_guestbook', ({ targetUser }, cb) => {
    const u = users[targetUser];
    cb && cb(u ? (u.guestbook || []) : []);
  });

  // ── 연결 해제 ──
  socket.on('disconnect', () => {
    const me = socket.username;
    if (me) {
      delete onlineUsers[me];
      io.emit('online_update', Object.keys(onlineUsers));
    }
    delete sessions[socket.id];
  });
});

// ── 서버 시작 ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`반카이톡 서버 가동 중 — 포트 ${PORT}`));
