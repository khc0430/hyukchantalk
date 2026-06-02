const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

// 인메모리 데이터 (DB 대체)
const users = {}; // socket.id: { username, status }
const channels = { '전체-광장': [] }; // 채널별 메시지 저장

// KST 시간 변환 함수
function getKSTTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kst = new Date(utc + (9 * 3600000));
    let hours = kst.getHours();
    const minutes = kst.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? '오후' : '오전';
    hours = hours % 12 || 12;
    return `${ampm} ${hours}:${minutes}`;
}

io.on('connection', (socket) => {
    console.log(`[영압 감지] 새로운 소켓 연결: ${socket.id}`);

    // 사신 인증 (로그인)
    socket.on('login', (username) => {
        users[socket.id] = { username, isOnline: true };
        socket.emit('login_success', username);
        io.emit('user_list', Object.values(users));
        console.log(`[사신 등록 완료] ${username}`);
    });

    // 참격 발사 (메시지 전송)
    socket.on('send_message', (data) => {
        const time = getKSTTime();
        const messageData = {
            id: Date.now(),
            sender: users[socket.id]?.username || '알 수 없는 사신',
            text: data.text,
            time: time,
            channel: data.channel || '전체-광장'
        };
        
        if (!channels[messageData.channel]) {
            channels[messageData.channel] = [];
        }
        channels[messageData.channel].push(messageData);
        
        io.emit('receive_message', messageData);
    });

    // 영압 요동 (입력 중 상태)
    socket.on('typing', (isTyping) => {
        if (users[socket.id]) {
            socket.broadcast.emit('user_typing', {
                username: users[socket.id].username,
                isTyping
            });
        }
    });

    // 영압 소멸 (연결 해제)
    socket.on('disconnect', () => {
        if (users[socket.id]) {
            console.log(`[영압 소멸] ${users[socket.id].username} 연결 끊김`);
            delete users[socket.id];
            io.emit('user_list', Object.values(users));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[소울 소사이어티 게이트 개방] http://localhost:${PORT}`);
});
