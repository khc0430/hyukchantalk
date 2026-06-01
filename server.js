const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 파일 업로드 설정 (static/uploads 대신 public/uploads 사용)
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// 데이터 저장용 (메모리 방식)
let users = {};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 프로필 업데이트 API
app.post('/upload', upload.single('profile_pic'), (req, res) => {
    const { userId, name, statusMsg } = req.body;
    if (!users[userId]) users[userId] = { id: userId };
    
    users[userId].name = name || userId;
    users[userId].statusMsg = statusMsg || '안녕하세요!';
    if (req.file) {
        users[userId].profilePic = '/uploads/' + req.file.filename;
    }
    
    res.json({ success: true, profile: users[userId] });
});

// 실시간 통신
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = userId;
        if (!users[userId]) {
            users[userId] = { 
                id: userId, 
                name: userId, 
                statusMsg: '안녕하세요!', 
                profilePic: 'https://cdn-icons-png.flaticon.com/512/149/149071.png',
                active: true
            };
        }
        users[userId].active = true;
        users[userId].lastActive = Date.now();
        io.emit('user_list', Object.values(users));
    });

    socket.on('send_msg', (data) => {
        if (!socket.userId || !users[socket.userId]) return;
        
        const msg = {
            user: socket.userId,
            name: users[socket.userId].name,
            text: data.text,
            pic: users[socket.userId].profilePic,
            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };
        io.emit('new_msg', msg);
    });

    // 10초마다 활동 상태 체크를 위한 핑
    socket.on('heartbeat', () => {
        if (socket.userId && users[socket.userId]) {
            users[socket.userId].lastActive = Date.now();
            users[socket.userId].active = true;
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId && users[socket.userId]) {
            users[socket.userId].active = false;
            io.emit('user_list', Object.values(users));
        }
    });
});

// 주기적으로 비활동 유저 체크 (1분 이상 무응답 시 오프라인)
setInterval(() => {
    const now = Date.now();
    let changed = false;
    Object.values(users).forEach(u => {
        if (u.active && (now - u.lastActive > 60000)) {
            u.active = false;
            changed = true;
        }
    });
    if (changed) io.emit('user_list', Object.values(users));
}, 10000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
