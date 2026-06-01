const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 고양이 사진 업로드 경로 설정
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// 인메모리 고양이 데이터베이스 구조
let users = {};          // { id: { id, password, name, statusMsg, profilePic, likes:[], comments:[], active:false, currentRoom: null } }
let posts = [];          // [ { id, authorId, authorName, authorPic, text, image, timestamp, likes:[], comments:[] } ]
let globalMessages = []; // [ { id, senderId, senderName, senderPic, text, timestamp } ]
let privateMessages = [];// [ { id, room, senderId, text, timestamp, readBy: [] } ]

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 1. 회원가입
app.post('/api/register', (req, res) => {
    const { id, password } = req.body;
    if (users[id]) return res.json({ success: false, msg: '이미 존재하는 아이디냥!' });
    users[id] = {
        id, password,
        name: '귀여운 집사',
        statusMsg: '냥찬톡에 오신 걸 환영한다냥🐾',
        profilePic: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=150', // 기본 고양이 프로필
        likes: [],
        comments: [],
        active: false,
        currentRoom: null
    };
    res.json({ success: true });
});

// 2. 로그인
app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    if (users[id] && users[id].password === password) {
        res.json({ success: true, user: users[id] });
    } else {
        res.json({ success: false, msg: '아이디나 비밀번호가 틀렸다냥!' });
    }
});

// 3. 내 프로필 수정
app.post('/api/profile', upload.single('profile_pic'), (req, res) => {
    const { id, name, statusMsg } = req.body;
    if (!users[id]) return res.json({ success: false });
    users[id].name = name || users[id].name;
    users[id].statusMsg = statusMsg || users[id].statusMsg;
    if (req.file) users[id].profilePic = '/uploads/' + req.file.filename;
    res.json({ success: true, user: users[id] });
});

// 4. 피드 게시글 등록
app.post('/api/posts', upload.single('post_img'), (req, res) => {
    const { authorId, text } = req.body;
    if (!users[authorId]) return res.json({ success: false });
    const newPost = {
        id: 'post_' + Date.now(),
        authorId,
        authorName: users[authorId].name,
        authorPic: users[authorId].profilePic,
        text,
        image: req.file ? '/uploads/' + req.file.filename : null,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        likes: [],
        comments: []
    };
    posts.unshift(newPost);
    io.emit('update_posts', posts);
    res.json({ success: true });
});

// 웹소켓 실시간 냥냥 네트워크
io.on('connection', (socket) => {
    let currentUserId = null;

    socket.on('join', (id) => {
        if (!users[id]) return;
        currentUserId = id;
        socket.userId = id;
        users[id].active = true;
        
        sendUserList();
        socket.emit('update_posts', posts);
        socket.emit('init_global_chat', globalMessages);
    });

    // 룸(채팅방) 전환 추적 (읽음 처리용)
    socket.on('switch_room', ({ userId, room }) => {
        if (!users[userId]) return;
        users[userId].currentRoom = room;

        if (room !== 'global' && room !== null) {
            // 상대방이 보낸 안읽은 메시지 전부 읽음 처리
            privateMessages.forEach(msg => {
                if (msg.room === room && msg.senderId !== userId) {
                    if (!msg.readBy.includes(userId)) msg.readBy.push(userId);
                }
            });
            io.to(room).emit('update_private_chat', getPrivateRoomMessages(room));
            sendUserList(); // 읽음으로 인한 뱃지 상태 업데이트
        }
        socket.join(room);
    });

    // 전체 채팅 전송
    socket.on('send_global', (data) => {
        const msg = {
            id: 'g_' + Date.now(),
            senderId: data.senderId,
            senderName: users[data.senderId].name,
            senderPic: users[data.senderId].profilePic,
            text: data.text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        globalMessages.push(msg);
        io.emit('receive_global', msg);
    });

    // 1:1 개인 채팅 전송
    socket.on('send_private', (data) => {
        const { senderId, targetId, text } = data;
        const room = [senderId, targetId].sort().join('-');
        
        // 대상이 현재 이 방을 보고 있다면 즉시 읽음 처리
        const readBy = [senderId];
        if (users[targetId] && users[targetId].currentRoom === room) {
            readBy.push(targetId);
        }

        const msg = {
            id: 'p_' + Date.now(),
            room,
            senderId,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            readBy
        };
        privateMessages.push(msg);
        
        io.to(room).emit('receive_private', msg);
        
        // 상대방이 다른 방에 있다면 알림 및 뱃지 갱신 유도
        if (users[targetId] && users[targetId].currentRoom !== room) {
            io.emit('notify_private_badge', { targetId, senderId });
            io.emit('push_notification', {
                targetId,
                title: '🐾 새 꾹꾹이 메시지!',
                body: `${users[senderId].name}: ${text.substring(0, 15)}...`
            });
        }
    });

    // 실시간 타이핑 감지 (꾹꾹이 중...)
    socket.on('typing', (data) => {
        io.emit('display_typing', data);
    });

    // 피드 & 프로필 소셜 인터랙션 (좋아요/댓글)
    socket.on('like_event', ({ type, targetId, userId, postId }) => {
        if (type === 'profile') {
            if (!users[targetId].likes.includes(userId)) {
                users[targetId].likes.push(userId);
                triggerNotification(targetId, `🐾 ${users[userId].name}님이 프로필에 꾹꾹이(좋아요)를 보냈다냥!`);
            } else {
                users[targetId].likes = users[targetId].likes.filter(id => id !== userId);
            }
            sendUserList();
        } else if (type === 'post') {
            const post = posts.find(p => p.id === postId);
            if (post) {
                if (!post.likes.includes(userId)) {
                    post.likes.push(userId);
                    triggerNotification(post.authorId, `🐾 ${users[userId].name}님이 게시글을 좋아한다냥!`);
                } else {
                    post.likes = post.likes.filter(id => id !== userId);
                }
                io.emit('update_posts', posts);
            }
        }
    });

    socket.on('comment_event', ({ type, targetId, userId, postId, text, parentId }) => {
        const commentObj = {
            id: 'cmt_' + Date.now(),
            authorId: userId,
            authorName: users[userId].name,
            authorPic: users[userId].profilePic,
            text,
            parentId: parentId || null,
            timestamp: new Date().toLocaleDateString()
        };

        if (type === 'profile') {
            users[targetId].comments.push(commentObj);
            triggerNotification(targetId, `🐾 ${users[userId].name}님이 방명록에 냐옹 댓글을 달았다냥!`);
            sendUserList();
        } else if (type === 'post') {
            const post = posts.find(p => p.id === postId);
            if (post) {
                post.comments.push(commentObj);
                triggerNotification(post.authorId, `🐾 ${users[userId].name}님이 게시글에 냐옹 댓글을 달았다냥!`);
                io.emit('update_posts', posts);
            }
        }
    });

    socket.on('disconnect', () => {
        if (currentUserId && users[currentUserId]) {
            users[currentUserId].active = false;
            users[currentUserId].currentRoom = null;
            sendUserList();
        }
    });

    function sendUserList() {
        // 안읽은 개인 메시지 계산 포함하여 전달
        const uList = Object.values(users).map(u => {
            const unreadSenders = new Set();
            privateMessages.forEach(msg => {
                const isMyRoom = msg.room.includes(u.id);
                if (isMyRoom && msg.senderId !== u.id && !msg.readBy.includes(u.id)) {
                    unreadSenders.add(msg.senderId);
                }
            });
            return {
                id: u.id, name: u.name, statusMsg: u.statusMsg, profilePic: u.profilePic,
                active: u.active, likes: u.likes, comments: u.comments, currentRoom: u.currentRoom,
                unreadPrivateCount: unreadSenders.size
            };
        });
        io.emit('user_list', uList);
    }

    function getPrivateRoomMessages(room) {
        return privateMessages.filter(msg => msg.room === room);
    }

    function triggerNotification(targetId, text) {
        io.emit('push_notification', { targetId, title: '🐱 냥냥 알림!', body: text });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`냥찬톡 서버 가동 완료: http://localhost:${PORT}`));
