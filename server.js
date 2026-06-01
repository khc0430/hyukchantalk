const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 인메모리 데이터베이스 (서버가 켜져있는 동안 유지)
const users = {}; // { id: { pw, nickname, status, photo, online, socketId } }
const posts = []; // { id, authorId, content, image, likes:[], comments:[] }
const globalChat = []; // { id, authorId, text, time }
const privateChats = {}; // 'user1_user2': [ { authorId, text, time, read } ]

// 🕒 대한민국 시간(KST) 생성 함수
const getKST = () => {
    return new Date().toLocaleTimeString('ko-KR', { 
        timeZone: 'Asia/Seoul', hour12: true, hour: '2-digit', minute:'2-digit' 
    });
};

// 1:1 채팅방 고유 ID 생성 (알파벳 순 정렬로 항상 같은 방 ID 도출)
const getRoomId = (id1, id2) => [id1, id2].sort().join('_');

io.on('connection', (socket) => {
    
    // [회원가입 및 로그인]
    socket.on('auth', ({ type, id, pw, nickname }) => {
        if (type === 'register') {
            if (users[id]) return socket.emit('authResult', { success: false, msg: '이미 존재하는 아이디입니다냥!' });
            users[id] = { pw, nickname: nickname || id, status: '', photo: '', online: true, socketId: socket.id };
            socket.userId = id;
            socket.emit('authResult', { success: true, isNew: true, user: users[id], globalChat });
            io.emit('updateUserList', getUsersExcept(id));
        } else if (type === 'login') {
            const user = users[id];
            if (!user || user.pw !== pw) return socket.emit('authResult', { success: false, msg: '아이디나 비번이 틀렸다냥!' });
            user.online = true;
            user.socketId = socket.id;
            socket.userId = id;
            socket.emit('authResult', { success: true, isNew: false, user, globalChat, posts });
            io.emit('updateUserList', getUsersExcept(id));
        }
    });

    // 유저 리스트 조회 헬퍼
    const getUsersExcept = (exceptId) => {
        return Object.keys(users).filter(k => k !== exceptId).map(k => ({
            id: k, nickname: users[k].nickname, status: users[k].status, photo: users[k].photo, online: users[k].online
        }));
    };

    socket.on('requestUserList', () => {
        if (socket.userId) socket.emit('updateUserList', getUsersExcept(socket.userId));
    });

    socket.on('requestPosts', () => socket.emit('updatePosts', posts));

    // [프로필 업데이트]
    socket.on('updateProfile', (data) => {
        if (!socket.userId) return;
        users[socket.userId].nickname = data.nickname;
        users[socket.userId].status = data.status;
        users[socket.userId].photo = data.photo;
        socket.emit('profileUpdated', users[socket.userId]);
        io.emit('updateUserList', getUsersExcept(socket.userId));
    });

    // [게시물 & 소통 트리]
    socket.on('createPost', (data) => {
        const post = { id: Date.now(), authorId: socket.userId, content: data.content, image: data.image, likes: [], comments: [] };
        posts.unshift(post);
        io.emit('updatePosts', posts);
    });

    socket.on('likePost', (postId) => {
        const post = posts.find(p => p.id === postId);
        if (post) {
            if (!post.likes.includes(socket.userId)) {
                post.likes.push(socket.userId);
                io.emit('updatePosts', posts);
                if(post.authorId !== socket.userId && users[post.authorId]?.online) {
                    io.to(users[post.authorId].socketId).emit('notification', { msg: `${users[socket.userId].nickname}님이 게시글을 좋아합니다냥!🐾`, target: 'feed' });
                }
            }
        }
    });

    socket.on('commentPost', ({ postId, text, parentId }) => {
        const post = posts.find(p => p.id === postId);
        if (post) {
            post.comments.push({ id: Date.now(), authorId: socket.userId, text, parentId, time: getKST() });
            io.emit('updatePosts', posts);
            if(post.authorId !== socket.userId && users[post.authorId]?.online) {
                io.to(users[post.authorId].socketId).emit('notification', { msg: `${users[socket.userId].nickname}님이 댓글을 남겼다냥!💬`, target: 'feed' });
            }
        }
    });

    // [전체 채팅]
    socket.on('sendGlobalMsg', (text) => {
        const msg = { id: Date.now(), authorId: socket.userId, nickname: users[socket.userId].nickname, text, time: getKST() };
        globalChat.push(msg);
        io.emit('newGlobalMsg', msg);
    });

    // [1:1 채팅]
    socket.on('joinPrivate', (targetId) => {
        const roomId = getRoomId(socket.userId, targetId);
        if (!privateChats[roomId]) privateChats[roomId] = [];
        
        // 상대방이 보낸 메시지 모두 '읽음' 처리
        privateChats[roomId].forEach(m => {
            if (m.authorId === targetId) m.read = true;
        });
        
        socket.join(roomId);
        socket.emit('loadPrivateChat', { targetId, messages: privateChats[roomId] });
        
        // 상대방에게 내가 읽었음을 실시간 알림
        if (users[targetId] && users[targetId].online) {
            io.to(users[targetId].socketId).emit('privateRead', { roomId, readerId: socket.userId });
        }
    });

    socket.on('sendPrivateMsg', ({ targetId, text }) => {
        const roomId = getRoomId(socket.userId, targetId);
        const msg = { id: Date.now(), authorId: socket.userId, text, time: getKST(), read: false };
        if (!privateChats[roomId]) privateChats[roomId] = [];
        privateChats[roomId].push(msg);

        // 내 방과 상대방 방에 메시지 전송
        io.to(roomId).emit('newPrivateMsg', { roomId, msg, targetId });
        socket.emit('newPrivateMsg', { roomId, msg, targetId });

        // 상대방이 오프라인이거나 다른 탭에 있을 때 알림
        if (users[targetId] && users[targetId].online) {
            io.to(users[targetId].socketId).emit('notification', { msg: `${users[socket.userId].nickname}님이 귓속말을 보냈다냥!💌`, target: 'friends', senderId: socket.userId });
        }
    });

    socket.on('markAsRead', ({ targetId }) => {
        const roomId = getRoomId(socket.userId, targetId);
        if (privateChats[roomId]) {
            privateChats[roomId].forEach(m => { if (m.authorId === targetId) m.read = true; });
            if (users[targetId] && users[targetId].online) {
                io.to(users[targetId].socketId).emit('privateRead', { roomId, readerId: socket.userId });
            }
        }
    });

    // [입력 중 상태 (Typing Indicator)]
    socket.on('typing', ({ targetId, isTyping }) => {
        const nickname = users[socket.userId].nickname;
        if (targetId === 'global') {
            socket.broadcast.emit('userTyping', { targetId: 'global', nickname, isTyping });
        } else {
            const targetUser = users[targetId];
            if (targetUser && targetUser.online) {
                io.to(targetUser.socketId).emit('userTyping', { targetId: socket.userId, nickname, isTyping });
            }
        }
    });

    // 연결 해제
    socket.on('disconnect', () => {
        if (socket.userId && users[socket.userId]) {
            users[socket.userId].online = false;
            io.emit('updateUserList', getUsersExcept(socket.userId));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`😻 혁찬톡 고양이 서버가 ${PORT} 포트에서 갸르릉 거립니다!`));
