const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// ─── 업로드 디렉토리 ───────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── KST 시간 ──────────────────────────────────────────────────────────────────
function kstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).toISOString();
}

// ─── 인메모리 DB ────────────────────────────────────────────────────────────────
const DB = {
  users: {},        // { username: { password, nickname, status, avatar, isNew, createdAt } }
  posts: [],        // [{ id, author, content, image, likes[], comments[], createdAt }]
  stories: [],      // [{ id, author, content, image, createdAt, expiresAt }]
  globalMsgs: [],   // 전체 채팅
  channels: {       // 분대 채널
    '이치고-분대': [],
    '아이젠-토론': [],
    '호로-구역': []
  },
  dms: {},          // { roomId: [ msg ] }
  guestbooks: {},   // { targetUser: [ { author, content, parentId, id, createdAt } ] }
  profileLikes: {}, // { targetUser: Set(likers) }
};

// 온라인 유저: { socketId: username }
const onlineUsers = {};
// username → socketId
const userSockets = {};
// DM room → Set of usernames currently inside room
const roomPresence = {};

// ─── 유틸 ───────────────────────────────────────────────────────────────────────
function getRoomId(a, b) {
  return [a, b].sort().join('::');
}

function cleanExpiredStories() {
  const now = new Date();
  DB.stories = DB.stories.filter(s => new Date(s.expiresAt) > now);
}

// ─── REST API ───────────────────────────────────────────────────────────────────

// 회원가입
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  if (DB.users[username]) return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
  const hash = await bcrypt.hash(password, 10);
  DB.users[username] = {
    password: hash,
    nickname: username,
    status: '소울 소사이어티에 입장했다.',
    avatar: null,
    isNew: true,
    createdAt: kstNow()
  };
  res.json({ ok: true });
});

// 로그인
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = DB.users[username];
  if (!user) return res.status(401).json({ error: '존재하지 않는 아이디입니다.' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  const isNew = user.isNew;
  user.isNew = false;
  res.json({
    ok: true,
    username,
    nickname: user.nickname,
    status: user.status,
    avatar: user.avatar,
    isNew
  });
});

// 프로필 업데이트
app.post('/api/profile', upload.single('avatar'), (req, res) => {
  const { username, nickname, status } = req.body;
  const user = DB.users[username];
  if (!user) return res.status(404).json({ error: '유저 없음' });
  if (nickname) user.nickname = nickname;
  if (status !== undefined) user.status = status;
  if (req.file) user.avatar = `/uploads/${req.file.filename}`;
  res.json({ ok: true, nickname: user.nickname, status: user.status, avatar: user.avatar });
});

// 유저 목록
app.get('/api/users', (req, res) => {
  const list = Object.entries(DB.users).map(([u, d]) => ({
    username: u,
    nickname: d.nickname,
    status: d.status,
    avatar: d.avatar,
    online: !!userSockets[u]
  }));
  res.json(list);
});

// 게시글 목록
app.get('/api/posts', (req, res) => {
  cleanExpiredStories();
  res.json(DB.posts.slice().reverse());
});

// 게시글 작성
app.post('/api/posts', upload.single('image'), (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) return res.status(400).json({ error: '내용을 입력하세요.' });
  const post = {
    id: Date.now().toString(),
    author,
    content,
    image: req.file ? `/uploads/${req.file.filename}` : null,
    likes: [],
    comments: [],
    createdAt: kstNow()
  };
  DB.posts.push(post);
  io.emit('new_post', post);
  res.json(post);
});

// 게시글 좋아요
app.post('/api/posts/:id/like', (req, res) => {
  const { username } = req.body;
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없음' });
  const idx = post.likes.indexOf(username);
  if (idx === -1) {
    post.likes.push(username);
    // 알림
    if (post.author !== username && userSockets[post.author]) {
      io.to(userSockets[post.author]).emit('notification', {
        type: 'post_like',
        from: username,
        postId: post.id,
        message: `${DB.users[username]?.nickname || username}님이 당신의 영혼 기록에 영압 공명했습니다!`
      });
    }
  } else {
    post.likes.splice(idx, 1);
  }
  io.emit('post_liked', { postId: post.id, likes: post.likes });
  res.json({ likes: post.likes });
});

// 댓글 작성
app.post('/api/posts/:id/comments', (req, res) => {
  const { author, content, parentId } = req.body;
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '없음' });
  const comment = {
    id: Date.now().toString(),
    author,
    content,
    parentId: parentId || null,
    createdAt: kstNow()
  };
  post.comments.push(comment);
  if (post.author !== author && userSockets[post.author]) {
    io.to(userSockets[post.author]).emit('notification', {
      type: 'post_comment',
      from: author,
      postId: post.id,
      message: `${DB.users[author]?.nickname || author}님이 귀도술을 시전했습니다!`
    });
  }
  io.emit('post_commented', { postId: post.id, comment });
  res.json(comment);
});

// 스토리(잔향) 작성
app.post('/api/stories', upload.single('image'), (req, res) => {
  const { author, content } = req.body;
  const now = new Date(kstNow());
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const story = {
    id: Date.now().toString(),
    author,
    content,
    image: req.file ? `/uploads/${req.file.filename}` : null,
    createdAt: kstNow(),
    expiresAt
  };
  DB.stories.push(story);
  io.emit('new_story', story);
  res.json(story);
});

// 스토리 목록
app.get('/api/stories', (req, res) => {
  cleanExpiredStories();
  res.json(DB.stories);
});

// 방명록 가져오기
app.get('/api/guestbook/:username', (req, res) => {
  res.json(DB.guestbooks[req.params.username] || []);
});

// 방명록 작성
app.post('/api/guestbook/:username', (req, res) => {
  const { author, content, parentId } = req.body;
  const target = req.params.username;
  if (!DB.guestbooks[target]) DB.guestbooks[target] = [];
  const entry = {
    id: Date.now().toString(),
    author,
    content,
    parentId: parentId || null,
    createdAt: kstNow()
  };
  DB.guestbooks[target].push(entry);
  if (target !== author && userSockets[target]) {
    io.to(userSockets[target]).emit('notification', {
      type: 'guestbook',
      from: author,
      message: `${DB.users[author]?.nickname || author}님이 방명록에 귀도술을 남겼습니다!`
    });
  }
  res.json(entry);
});

// 프로필 좋아요
app.post('/api/profile-like/:username', (req, res) => {
  const { from } = req.body;
  const target = req.params.username;
  if (!DB.profileLikes[target]) DB.profileLikes[target] = [];
  const idx = DB.profileLikes[target].indexOf(from);
  if (idx === -1) {
    DB.profileLikes[target].push(from);
    if (target !== from && userSockets[target]) {
      io.to(userSockets[target]).emit('notification', {
        type: 'profile_like',
        from,
        message: `${DB.users[from]?.nickname || from}님이 당신의 영혼 카드에 영압 공명했습니다!`
      });
    }
  } else {
    DB.profileLikes[target].splice(idx, 1);
  }
  res.json({ likes: DB.profileLikes[target] });
});

// 채널 목록
app.get('/api/channels', (req, res) => {
  res.json(Object.keys(DB.channels));
});

// 채널 생성
app.post('/api/channels', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '채널명 필요' });
  if (!DB.channels[name]) {
    DB.channels[name] = [];
    io.emit('channel_created', name);
  }
  res.json({ ok: true });
});

// 채널 메시지
app.get('/api/channels/:name/messages', (req, res) => {
  const msgs = DB.channels[req.params.name];
  if (!msgs) return res.status(404).json({ error: '없음' });
  res.json(msgs);
});

// 전체 채팅 기록
app.get('/api/global-messages', (req, res) => {
  res.json(DB.globalMsgs);
});

// DM 기록
app.get('/api/dm/:roomId', (req, res) => {
  res.json(DB.dms[req.params.roomId] || []);
});

// 파일 업로드 (채팅용)
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

// ─── SOCKET.IO ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // 로그인 등록
  socket.on('register_user', (username) => {
    onlineUsers[socket.id] = username;
    userSockets[username] = socket.id;
    io.emit('user_status', { username, online: true });
  });

  // ── 전체 채팅 ──
  socket.on('global_message', (data) => {
    // data: { author, content, replyTo, fileUrl, fileName, fileSize, fileMime, reactions }
    const msg = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      author: data.author,
      content: data.content || '',
      replyTo: data.replyTo || null,
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      fileSize: data.fileSize || null,
      fileMime: data.fileMime || null,
      reactions: {},
      createdAt: kstNow()
    };
    DB.globalMsgs.push(msg);
    io.emit('global_message', msg);
  });

  // ── 채널 메시지 ──
  socket.on('channel_message', (data) => {
    // data: { channel, author, content, replyTo, fileUrl, ... }
    if (!DB.channels[data.channel]) return;
    const msg = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      author: data.author,
      content: data.content || '',
      replyTo: data.replyTo || null,
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      fileSize: data.fileSize || null,
      fileMime: data.fileMime || null,
      reactions: {},
      createdAt: kstNow()
    };
    DB.channels[data.channel].push(msg);
    io.emit('channel_message', { channel: data.channel, msg });
  });

  // ── DM ──
  socket.on('join_dm', ({ roomId, username }) => {
    socket.join(roomId);
    if (!roomPresence[roomId]) roomPresence[roomId] = new Set();
    roomPresence[roomId].add(username);
    // 읽음 처리
    if (DB.dms[roomId]) {
      DB.dms[roomId].forEach(m => {
        if (m.author !== username && !m.read) {
          m.read = true;
        }
      });
      io.to(roomId).emit('dm_read_update', { roomId });
    }
  });

  socket.on('leave_dm', ({ roomId, username }) => {
    socket.leave(roomId);
    if (roomPresence[roomId]) roomPresence[roomId].delete(username);
  });

  socket.on('dm_message', (data) => {
    // data: { roomId, author, recipient, content, replyTo, fileUrl, ... }
    const { roomId, author, recipient } = data;
    if (!DB.dms[roomId]) DB.dms[roomId] = [];
    const inRoom = roomPresence[roomId] || new Set();
    const msg = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      author,
      content: data.content || '',
      replyTo: data.replyTo || null,
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      fileSize: data.fileSize || null,
      fileMime: data.fileMime || null,
      reactions: {},
      read: inRoom.has(recipient),
      createdAt: kstNow()
    };
    DB.dms[roomId].push(msg);
    io.to(roomId).emit('dm_message', { roomId, msg });

    // 알림 (상대방이 방에 없을 때)
    if (!inRoom.has(recipient) && userSockets[recipient]) {
      io.to(userSockets[recipient]).emit('notification', {
        type: 'dm',
        from: author,
        roomId,
        message: `${DB.users[author]?.nickname || author}님의 비밀 귀도가 도착했습니다!`
      });
      io.to(userSockets[recipient]).emit('dm_badge', { from: author });
    }
  });

  // ── 리액션 ──
  socket.on('add_reaction', ({ scope, id, channelOrRoom, emoji, username }) => {
    // scope: 'global' | 'channel' | 'dm'
    let msg;
    if (scope === 'global') msg = DB.globalMsgs.find(m => m.id === id);
    else if (scope === 'channel') msg = (DB.channels[channelOrRoom] || []).find(m => m.id === id);
    else if (scope === 'dm') msg = (DB.dms[channelOrRoom] || []).find(m => m.id === id);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(username);
    if (idx === -1) msg.reactions[emoji].push(username);
    else msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

    const payload = { scope, id, channelOrRoom, reactions: msg.reactions };
    if (scope === 'global') io.emit('reaction_updated', payload);
    else if (scope === 'channel') io.emit('reaction_updated', payload);
    else io.to(channelOrRoom).emit('reaction_updated', payload);
  });

  // ── 입력 중 ──
  socket.on('typing', ({ scope, channelOrRoom, username }) => {
    if (scope === 'global') socket.broadcast.emit('typing', { scope, username });
    else if (scope === 'channel') socket.broadcast.emit('typing', { scope, channelOrRoom, username });
    else socket.to(channelOrRoom).emit('typing', { scope, channelOrRoom, username });
  });

  socket.on('stop_typing', ({ scope, channelOrRoom, username }) => {
    if (scope === 'global') socket.broadcast.emit('stop_typing', { scope, username });
    else if (scope === 'channel') socket.broadcast.emit('stop_typing', { scope, channelOrRoom, username });
    else socket.to(channelOrRoom).emit('stop_typing', { scope, channelOrRoom, username });
  });

  // ── 연결 해제 ──
  socket.on('disconnect', () => {
    const username = onlineUsers[socket.id];
    if (username) {
      delete onlineUsers[socket.id];
      delete userSockets[username];
      io.emit('user_status', { username, online: false });
    }
  });
});

// ─── 서버 시작 ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚔️  반카이톡 서버 가동 중 — 포트 ${PORT} — 반카이 발동!`);
});
