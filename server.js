// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 데이터 저장소 (실제 서비스에서는 DB 사용 권장) ---
const db = {
    users: {}, // {userId: {pw, nick, status, img, likes: 0, guestbook: []}}
    feeds: [], // [{id, authorId, authorNick, authorImg, content, img, likes: [], comments: []}]
    globalMessages: [],
    privateMessages: {}, // {"user1-user2": [{sender, text, time, read: false}]}
    onlineUsers: new Set(),
    socketToUser: {}
};

// 시간 설정 (KST)
const getKST = () => {
    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return kst;
};

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // 1. 로그인/회원가입
    socket.on('auth', ({ type, id, pw, nick }) => {
        if (type === 'signup') {
            if (db.users[id]) return socket.emit('auth_res', { success: false, msg: '이미 존재하는 아이디야! 야옹!' });
            db.users[id] = { 
                pw, nick, 
                status: '안녕! 반가워!', 
                img: 'https://cdn-icons-png.flaticon.com/512/6915/6915987.png', // 기본 고양이 이콘
                likes: 0, 
                guestbook: [],
                joined: getKST(),
                isFirst: true
            };
            socket.emit('auth_res', { success: true, user: {id, ...db.users[id]}, isNew: true });
        } else {
            const user = db.users[id];
            if (user && user.pw === pw) {
                user.isFirst = false;
                socket.emit('auth_res', { success: true, user: {id, ...user}, isNew: false });
            } else {
                socket.emit('auth_res', { success: false, msg: '아이디나 비번이 틀렸어! 냐앙..' });
            }
        }
    });

    // 2. 온라인 상태 관리
    socket.on('login_success', (userId) => {
        socket.userId = userId;
        db.onlineUsers.add(userId);
        db.socketToUser[socket.id] = userId;
        io.emit('update_user_list', {
            users: Object.keys(db.users).map(id => ({
                id,
                nick: db.users[id].nick,
                status: db.users[id].status,
                img: db.users[id].img,
                isOnline: db.onlineUsers.has(id)
            }))
        });
    });

    // 3. 피드 및 프로필 기능
    socket.on('update_profile', (data) => {
        const user = db.users[socket.userId];
        if(user) {
            user.nick = data.nick;
            user.status = data.status;
            user.img = data.img;
            io.emit('refresh_data'); // 전체 데이터 갱신 알림
        }
    });

    socket.on('post_feed', (data) => {
        const user = db.users[socket.userId];
        const newFeed = {
            id: Date.now(),
            authorId: socket.userId,
            authorNick: user.nick,
            authorImg: user.img,
            content: data.content,
            img: data.img,
            likes: [],
            comments: [],
            time: getKST()
        };
        db.feeds.unshift(newFeed);
        io.emit('feed_update', db.feeds);
    });

    // 트리형 댓글 로직 (대댓글)
    socket.on('add_comment', ({ feedId, text, parentId = null }) => {
        const feed = db.feeds.find(f => f.id === feedId);
        if (feed) {
            const comment = {
                id: Date.now(),
                authorId: socket.userId,
                authorNick: db.users[socket.userId].nick,
                text,
                parentId,
                time: getKST()
            };
            feed.comments.push(comment);
            io.emit('feed_update', db.feeds);
            
            // 알림 보내기
            if (feed.authorId !== socket.userId) {
                io.to(getSocketByUserId(feed.authorId)).emit('noti', {
                    msg: `${db.users[socket.userId].nick}님이 네 피드에 댓글을 달았어!`,
                    target: 'feed'
                });
            }
        }
    });

    // 4. 채팅 시스템
    // 전체 채팅
    socket.on('send_global', (text) => {
        const msg = {
            senderId: socket.userId,
            senderNick: db.users[socket.userId].nick,
            senderImg: db.users[socket.userId].img,
            text,
            time: getKST()
        };
        db.globalMessages.push(msg);
        io.emit('receive_global', msg);
    });

    // 1:1 채팅방 입장 및 읽음 처리
    socket.on('join_private', (targetId) => {
        const roomKey = [socket.userId, targetId].sort().join('-');
        socket.join(roomKey);
        socket.currentRoom = roomKey;

        if (!db.privateMessages[roomKey]) db.privateMessages[roomKey] = [];
        
        // 내가 들어온 순간 상대방이 보낸 메시지 모두 '읽음' 처리
        db.privateMessages[roomKey].forEach(m => {
            if (m.sender !== socket.userId) m.read = true;
        });

        socket.emit('private_history', db.privateMessages[roomKey]);
        io.to(roomKey).emit('read_update', { userId: socket.userId });
    });

    socket.on('send_private', ({ targetId, text }) => {
        const roomKey = [socket.userId, targetId].sort().join('-');
        const msg = {
            sender: socket.userId,
            text,
            time: getKST(),
            read: false
        };

        // 상대방이 방에 있는지 확인
        const targetSocketId = getSocketByUserId(targetId);
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket && targetSocket.currentRoom === roomKey) {
            msg.read = true;
        }

        db.privateMessages[roomKey].push(msg);
        io.to(roomKey).emit('receive_private', msg);

        // 알림 및 뱃지 업데이트
        if (!msg.read) {
            io.to(targetSocketId).emit('noti', {
                msg: `${db.users[socket.userId].nick}님에게 비밀 메시지가 왔어!`,
                target: 'chat_list',
                from: socket.userId
            });
        }
    });

    // 입력 중... 표시
    socket.on('typing', ({ targetId, isTyping }) => {
        const roomKey = targetId === 'global' ? 'global' : [socket.userId, targetId].sort().join('-');
        socket.to(roomKey).emit('display_typing', { userId: socket.userId, nick: db.users[socket.userId].nick, isTyping });
    });

    socket.on('disconnect', () => {
        db.onlineUsers.delete(socket.userId);
        delete db.socketToUser[socket.id];
        io.emit('update_user_list', { /* 위와 동일한 리스트 생성 로직 */ });
    });

    function getSocketByUserId(userId) {
        return Object.keys(db.socketToUser).find(key => db.socketToUser[key] === userId);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cat Paradise Server running on port ${PORT}`));
