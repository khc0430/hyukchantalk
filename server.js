// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 이미지 업로드를 위해 버퍼 사이즈 증가 (100MB)
});

app.use(express.static(path.join(__dirname, 'public')));

// --- 인메모리 데이터베이스 ---
const db = {
    users: {}, // { id: { id, pw, nickname, statusMsg, profilePic, isOnline, isFirstLogin } }
    globalChats: [], 
    privateChats: [], // { id, senderId, receiverId, text, time, isRead }
    posts: [], // { id, authorId, text, image, likes: [], comments: [] }
    guestbooks: {} // { userId: [ { id, authorId, text, time, parentId } ] }
};

// KST 시간 생성 함수
function getKSTTime() {
    return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: true, hour: '2-digit', minute:'2-digit' });
}
function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

io.on('connection', (socket) => {
    let currentUser = null;

    // 1. 로그인 / 회원가입
    socket.on('login', ({ id, pw }) => {
        let isFirst = false;
        if (!db.users[id]) {
            // 회원가입
            db.users[id] = { id, pw, nickname: id, statusMsg: '야옹~', profilePic: '', isOnline: true, isFirstLogin: true };
            isFirst = true;
        } else if (db.users[id].pw !== pw) {
            return socket.emit('login_error', '비밀번호가 틀렸습니다냥!');
        }
        
        currentUser = db.users[id];
        currentUser.isOnline = true;
        
        if (currentUser.isFirstLogin && !isFirst) currentUser.isFirstLogin = false; // 첫 로그인 상태 업데이트

        socket.join(currentUser.id); // 개인 룸 조인 (1:1 메시지 수신용)
        
        socket.emit('login_success', { 
            user: currentUser, 
            isFirst,
            globalChats: db.globalChats,
            posts: db.posts,
            users: Object.values(db.users)
        });
        
        io.emit('update_users', Object.values(db.users));
    });

    // 2. 프로필 업데이트
    socket.on('update_profile', (data) => {
        if (!currentUser) return;
        currentUser.nickname = data.nickname;
        currentUser.statusMsg = data.statusMsg;
        if (data.profilePic) currentUser.profilePic = data.profilePic;
        
        io.emit('update_users', Object.values(db.users));
        socket.emit('profile_updated', currentUser);
    });

    // 3. 게시글 (피드)
    socket.on('create_post', (data) => {
        const post = {
            id: generateId(),
            authorId: currentUser.id,
            text: data.text,
            image: data.image,
            likes: [],
            comments: [],
            time: getKSTTime()
        };
        db.posts.unshift(post);
        io.emit('new_post', post);
    });

    socket.on('like_post', (postId) => {
        const post = db.posts.find(p => p.id === postId);
        if (post && !post.likes.includes(currentUser.id)) {
            post.likes.push(currentUser.id);
            io.emit('post_updated', post);
            // 알림
            io.to(post.authorId).emit('notification', `${currentUser.nickname}님이 내 게시글에 꾹꾹이를 눌렀습니다냥!`);
        }
    });

    socket.on('comment_post', (data) => {
        const post = db.posts.find(p => p.id === data.postId);
        if (post) {
            post.comments.push({ id: generateId(), authorId: currentUser.id, text: data.text, parentId: data.parentId, time: getKSTTime() });
            io.emit('post_updated', post);
            io.to(post.authorId).emit('notification', `${currentUser.nickname}님이 댓글을 남겼습니다냥!`);
        }
    });

    // 4. 전체 채팅
    socket.on('send_global', (text) => {
        const msg = { id: generateId(), senderId: currentUser.id, text, time: getKSTTime() };
        db.globalChats.push(msg);
        io.emit('receive_global', msg);
    });

    // 5. 1:1 개인 채팅
    socket.on('send_private', (data) => {
        const msg = { 
            id: generateId(), 
            senderId: currentUser.id, 
            receiverId: data.receiverId, 
            text: data.text, 
            time: getKSTTime(), 
            isRead: false 
        };
        db.privateChats.push(msg);
        
        // 보낸 사람과 받는 사람에게만 전송
        socket.emit('receive_private', msg);
        io.to(data.receiverId).emit('receive_private', msg);
        io.to(data.receiverId).emit('notification', `${currentUser.nickname}님의 비밀 메시지다냥!`);
    });

    socket.on('get_private_history', (receiverId) => {
        const history = db.privateChats.filter(m => 
            (m.senderId === currentUser.id && m.receiverId === receiverId) ||
            (m.senderId === receiverId && m.receiverId === currentUser.id)
        );
        socket.emit('private_history', history);
    });

    // 1:1 읽음 처리 로직
    socket.on('mark_read', (senderId) => {
        let changed = false;
        db.privateChats.forEach(m => {
            if (m.senderId === senderId && m.receiverId === currentUser.id && !m.isRead) {
                m.isRead = true;
                changed = true;
            }
        });
        if (changed) {
            io.to(senderId).emit('messages_read_by_receiver', currentUser.id);
            socket.emit('messages_read_by_me', senderId);
        }
    });

    // 입력 중 상태
    socket.on('typing', (data) => {
        if (data.type === 'global') {
            socket.broadcast.emit('user_typing', { type: 'global', name: currentUser.nickname });
        } else {
            io.to(data.receiverId).emit('user_typing', { type: 'private', name: currentUser.nickname, senderId: currentUser.id });
        }
    });

    // 연결 종료
    socket.on('disconnect', () => {
        if (currentUser) {
            currentUser.isOnline = false;
            io.emit('update_users', Object.values(db.users));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`고양이 천국 혁찬톡 서버가 포트 ${PORT}에서 야옹거립니다.`);
});
