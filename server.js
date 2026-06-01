const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // 대용량 이미지 전송 허용

app.use(express.static('public'));

// 🗄️ 인메모리 DB (앱 종료 전까지 유지)
const users = {}; 
const posts = []; 
const globalChat = []; 
const privateChats = {}; 

// 🕒 시간 포맷팅 헬퍼
const getKST = () => new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: true, hour: '2-digit', minute:'2-digit' });
const getKSTDate = () => new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
const getRoomId = (id1, id2) => [id1, id2].sort().join('_');

io.on('connection', (socket) => {
    console.log('새로운 고양이 접속:', socket.id);

    // 🔐 [인증 & 자동 로그인 (로컬스토리지 연동)]
    socket.on('auth', ({ type, id, pw, nickname, autoLogin }) => {
        if (type === 'register') {
            if (users[id]) return socket.emit('authResult', { success: false, msg: '이미 존재하는 아이디다냥!' });
            users[id] = { id, pw, nickname: nickname || id, status: '', photo: '', online: true, socketId: socket.id };
            socket.userId = id;
            socket.emit('authResult', { success: true, isNew: true, user: users[id], globalChat, posts, token: autoLogin ? id : null });
            io.emit('updateUserList', getUsersExcept(id));
        } else if (type === 'login' || type === 'auto') {
            const user = users[id];
            if (!user || (type === 'login' && user.pw !== pw)) {
                return socket.emit('authResult', { success: false, msg: '정보가 일치하지 않는다냥!' });
            }
            user.online = true;
            user.socketId = socket.id;
            socket.userId = id;
            socket.emit('authResult', { success: true, isNew: false, user, globalChat, posts, token: id });
            io.emit('updateUserList', getUsersExcept(id));
        }
    });

    const getUsersExcept = (exceptId) => {
        return Object.keys(users).filter(k => k !== exceptId).map(k => ({
            id: k, nickname: users[k].nickname, status: users[k].status, photo: users[k].photo, online: users[k].online
        }));
    };

    socket.on('requestUserList', () => { if (socket.userId) socket.emit('updateUserList', getUsersExcept(socket.userId)); });
    socket.on('requestPosts', () => socket.emit('updatePosts', posts));
    socket.on('requestGlobalChat', () => socket.emit('loadGlobalChat', globalChat));

    // 🐾 [인스타그램형 피드 기능]
    socket.on('updateProfile', (data) => {
        if (!socket.userId) return;
        const u = users[socket.userId];
        u.nickname = data.nickname; u.status = data.status; u.photo = data.photo;
        posts.forEach(p => { if(p.authorId === socket.userId) { p.authorName = data.nickname; p.authorPhoto = data.photo; }});
        socket.emit('profileUpdated', u);
        io.emit('updateUserList', getUsersExcept(socket.userId));
        io.emit('updatePosts', posts);
    });

    socket.on('createPost', (data) => {
        const u = users[socket.userId];
        const post = { id: Date.now(), authorId: socket.userId, authorName: u.nickname, authorPhoto: u.photo, content: data.content, image: data.image, likes: [], comments: [], timestamp: Date.now() };
        posts.unshift(post);
        io.emit('updatePosts', posts);
    });

    socket.on('likePost', (postId) => {
        const post = posts.find(p => p.id === postId);
        if (post) {
            const idx = post.likes.indexOf(socket.userId);
            if (idx === -1) post.likes.push(socket.userId); else post.likes.splice(idx, 1); // 좋아요 취소 기능 추가
            io.emit('updatePosts', posts);
            if(idx === -1 && post.authorId !== socket.userId && users[post.authorId]?.online) {
                io.to(users[post.authorId].socketId).emit('notification', { msg: `${users[socket.userId].nickname}님이 게시글을 좋아해냥!❤️`, target: 'feed' });
            }
        }
    });

    socket.on('commentPost', ({ postId, text }) => {
        const post = posts.find(p => p.id === postId);
        if (post) {
            post.comments.push({ id: Date.now(), authorId: socket.userId, authorName: users[socket.userId].nickname, text, time: getKST() });
            io.emit('updatePosts', posts);
            if(post.authorId !== socket.userId && users[post.authorId]?.online) {
                io.to(users[post.authorId].socketId).emit('notification', { msg: `${users[socket.userId].nickname}님이 댓글을 달았다냥!💬`, target: 'feed' });
            }
        }
    });

    // 💬 [카카오톡형 채팅 기능 (날짜, 이미지 전송, 읽음 처리)]
    const handleMsg = (type, targetId, text, image) => {
        const u = users[socket.userId];
        const msg = { id: Date.now(), authorId: socket.userId, nickname: u.nickname, photo: u.photo, text, image, time: getKST(), date: getKSTDate(), read: false };
        
        if (type === 'global') {
            globalChat.push(msg);
            io.emit('newGlobalMsg', msg);
        } else {
            const roomId = getRoomId(socket.userId, targetId);
            if (!privateChats[roomId]) privateChats[roomId] = [];
            privateChats[roomId].push(msg);
            
            io.to(roomId).emit('newPrivateMsg', { roomId, msg, targetId });
            socket.emit('newPrivateMsg', { roomId, msg, targetId }); // 발송자 확인용

            if (users[targetId] && users[targetId].online) {
                io.to(users[targetId].socketId).emit('notification', { msg: `${u.nickname}님의 귓속말!💌`, target: 'friends', senderId: socket.userId });
                io.to(users[targetId].socketId).emit('receivePrivateMsgOut', { roomId, msg, senderId: socket.userId });
            }
        }
    };

    socket.on('sendGlobalMsg', ({ text, image }) => handleMsg('global', null, text, image));
    socket.on('sendPrivateMsg', ({ targetId, text, image }) => handleMsg('private', targetId, text, image));

    socket.on('joinPrivate', (targetId) => {
        const roomId = getRoomId(socket.userId, targetId);
        if (!privateChats[roomId]) privateChats[roomId] = [];
        privateChats[roomId].forEach(m => { if (m.authorId === targetId) m.read = true; });
        socket.join(roomId);
        socket.emit('loadPrivateChat', { targetId, messages: privateChats[roomId] });
        if (users[targetId] && users[targetId].online) io.to(users[targetId].socketId).emit('privateRead', { roomId, readerId: socket.userId });
    });

    socket.on('markAsRead', ({ targetId }) => {
        const roomId = getRoomId(socket.userId, targetId);
        if (privateChats[roomId]) {
            privateChats[roomId].forEach(m => { if (m.authorId === targetId) m.read = true; });
            if (users[targetId] && users[targetId].online) io.to(users[targetId].socketId).emit('privateRead', { roomId, readerId: socket.userId });
        }
    });

    socket.on('typing', ({ targetId, isTyping }) => {
        const u = users[socket.userId];
        if(!u) return;
        if (targetId === 'global') socket.broadcast.emit('userTyping', { targetId: 'global', nickname: u.nickname, isTyping });
        else if (users[targetId]?.online) io.to(users[targetId].socketId).emit('userTyping', { targetId: socket.userId, nickname: u.nickname, isTyping });
    });

    socket.on('disconnect', () => {
        if (socket.userId && users[socket.userId]) {
            users[socket.userId].online = false;
            io.emit('updateUserList', getUsersExcept(socket.userId));
        }
    });
});

server.listen(3000, () => console.log('🚀 혁찬톡 서버 풀가동! (포트 3000)'));
