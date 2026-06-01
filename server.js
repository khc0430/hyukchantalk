const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// 데이터 저장소
let users = {}; 
let globalMessages = [];

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/register', (req, res) => {
    const { id, password } = req.body;
    if (users[id]) return res.json({ success: false, msg: '이미 있는 아이디입니다.' });
    users[id] = {
        id, password, name: id, statusMsg: 'Fresh Vibes Only 🚀', bio: '혁찬톡 프로필에 오신 것을 환영합니다!',
        profilePic: 'https://cdn-icons-png.flaticon.com/512/149/149071.png',
        active: false, lastActive: Date.now(),
        likes: [], comments: [], notifications: []
    };
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    if (users[id] && users[id].password === password) {
        res.json({ success: true, user: users[id] });
    } else {
        res.json({ success: false, msg: '정보가 올바르지 않습니다.' });
    }
});

app.post('/api/profile', upload.single('profile_pic'), (req, res) => {
    const { id, name, statusMsg, bio } = req.body;
    if (!users[id]) return res.json({ success: false });
    users[id].name = name;
    users[id].statusMsg = statusMsg;
    users[id].bio = bio;
    if (req.file) users[id].profilePic = '/uploads/' + req.file.filename;
    res.json({ success: true, profile: users[id] });
});

io.on('connection', (socket) => {
    socket.on('join', (id) => {
        if (!users[id]) return;
        socket.userId = id;
        socket.join(id);
        users[id].active = true;
        users[id].lastActive = Date.now();
        broadcastUserList();
    });

    socket.on('send_global', (data) => {
        const msg = {
            user: socket.userId, name: users[socket.userId].name, text: data.text,
            pic: users[socket.userId].profilePic,
            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };
        globalMessages.push(msg);
        io.emit('new_global', msg);
    });

    socket.on('like_profile', (targetId) => {
        const target = users[targetId];
        const me = users[socket.userId];
        if (!target || target.likes.includes(socket.userId)) return;
        target.likes.push(socket.userId);
        const notif = { id: Date.now(), type: 'like', from: socket.userId, fromName: me.name, time: '방금 전' };
        target.notifications.unshift(notif);
        io.to(targetId).emit('notification', notif);
        broadcastUserList();
    });

    socket.on('add_comment', (data) => {
        const { targetId, text, parentId } = data;
        const target = users[targetId];
        const me = users[socket.userId];
        if (!target) return;
        const newComment = {
            id: Date.now(), authorId: socket.userId, authorName: me.name,
            authorPic: me.profilePic, text, time: '방금 전', replies: []
        };
        if (parentId) {
            const parent = target.comments.find(c => c.id === parentId);
            if (parent) parent.replies.push(newComment);
        } else {
            target.comments.unshift(newComment);
        }
        const notif = { id: Date.now(), type: 'comment', from: socket.userId, fromName: me.name, text: text, time: '방금 전' };
        target.notifications.unshift(notif);
        io.to(targetId).emit('notification', notif);
        broadcastUserList();
    });

    socket.on('heartbeat', () => {
        if (socket.userId && users[socket.userId]) {
            users[socket.userId].lastActive = Date.now();
            users[socket.userId].active = true;
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId && users[socket.userId]) {
            users[socket.userId].active = false;
            broadcastUserList();
        }
    });
});

function broadcastUserList() {
    io.emit('user_list', Object.values(users).map(u => {
        const { password, ...safeUser } = u;
        return safeUser;
    }));
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
