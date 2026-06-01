const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 인메모리 데이터베이스 (실제 서비스 시 DB 대체)
const users = {};       // socket.id -> user profile
const feeds = [];       // 피드 게시글 리스트
const globalMessages = []; // 전체 채팅 메시지
const privateMessages = []; // 1:1 메시지 리스트

io.on('connection', (socket) => {
    console.log('🐾 고양이 한 마리 접속:', socket.id);

    // 1. 로그인 / 회원가입
    socket.on('login', ({ nickname, statusMsg, profilePic }) => {
        users[socket.id] = {
            id: socket.id,
            nickname: nickname || `익명냐옹_${socket.id.substring(0, 4)}`,
            statusMsg: statusMsg || '야옹~ 오늘두 행복한 하루!',
            profilePic: profilePic || '🐱',
            online: true,
            likes: 0,
            guestbook: []
        };
        
        // 본인에게 가입 승인 및 초기 데이터 전송
        socket.emit('login_success', {
            myId: socket.id,
            feeds,
            globalMessages,
            isNewUser: true // 첫 접속 공지창 팝업 트리거
        });

        // 모든 클라이언트에 유저 리스트 갱신
        io.emit('update_users', Object.values(users));
    });

    // 2. 프로필 수정
    socket.on('update_profile', ({ nickname, statusMsg, profilePic }) => {
        if (users[socket.id]) {
            users[socket.id].nickname = nickname;
            users[socket.id].statusMsg = statusMsg;
            users[socket.id].profilePic = profilePic;
            io.emit('update_users', Object.values(users));
        }
    });

    // 3. 피드(게시글) 작성
    socket.on('create_feed', ({ content, image }) => {
        const user = users[socket.id];
        if (!user) return;

        const newFeed = {
            id: 'feed_' + Date.now(),
            authorId: socket.id,
            authorName: user.nickname,
            authorPic: user.profilePic,
            content,
            image: image || null,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            likes: [],
            comments: []
        };

        feeds.unshift(newFeed);
        io.emit('update_feeds', feeds);

        // 작성자 제외 전원에게 알림 보내기
        socket.broadcast.emit('new_notification', {
            type: 'feed',
            text: `🐾 ${user.nickname}님이 새 피드를 작성했다냥!`,
            targetTab: 'feed'
        });
    });

    // 피드 좋아요
    socket.on('like_feed', (feedId) => {
        const feed = feeds.find(f => f.id === feedId);
        if (feed) {
            const index = feed.likes.indexOf(socket.id);
            if (index === -1) {
                feed.likes.push(socket.id);
                // 글쓴이에게 알림
                if (io.sockets.sockets.get(feed.authorId)) {
                    io.to(feed.authorId).emit('new_notification', {
                        type: 'feed',
                        text: `❤️ ${users[socket.id]?.nickname || '누군가'}님이 내 피드를 좋아한다냥!`,
                        targetTab: 'feed'
                    });
                }
            } else {
                feed.likes.splice(index, 1);
            }
            io.emit('update_feeds', feeds);
        }
    });

    // 피드 댓글/대댓글 작성 (트리 구조)
    socket.on('comment_feed', ({ feedId, parentId, content }) => {
        const feed = feeds.find(f => f.id === feedId);
        if (!feed) return;

        const newComment = {
            id: 'comment_' + Date.now(),
            parentId: parentId || null,
            authorName: users[socket.id]?.nickname || '익명냐옹',
            authorPic: users[socket.id]?.profilePic || '🐱',
            content,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        feed.comments.push(newComment);
        io.emit('update_feeds', feeds);

        // 알림 타겟 결정
        if (io.sockets.sockets.get(feed.authorId) && feed.authorId !== socket.id) {
            io.to(feed.authorId).emit('new_notification', {
                type: 'feed',
                text: `💬 ${users[socket.id]?.nickname}님이 내 피드에 댓글을 달았다냥!`,
                targetTab: 'feed'
            });
        }
    });

    // 4. 친구 프로필 팝업 - 좋아요 및 방명록
    socket.on('like_friend', (friendId) => {
        if (users[friendId]) {
            users[friendId].likes += 1;
            io.emit('update_users', Object.values(users));
            io.to(friendId).emit('new_notification', {
                type: 'friend',
                text: `💖 ${users[socket.id]?.nickname}님이 내 프로필에 하트를 꾹 눌렀다냥!`,
                targetTab: 'friend'
            });
        }
    });

    socket.on('submit_guestbook', ({ friendId, parentId, content }) => {
        if (users[friendId]) {
            const newMsg = {
                id: 'gb_' + Date.now(),
                parentId: parentId || null,
                authorName: users[socket.id]?.nickname || '익명냐옹',
                authorPic: users[socket.id]?.profilePic || '🐱',
                content,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            users[friendId].guestbook.push(newMsg);
            io.emit('update_users', Object.values(users));
            
            if (friendId !== socket.id) {
                io.to(friendId).emit('new_notification', {
                    type: 'friend',
                    text: `🐾 ${users[socket.id]?.nickname}님이 내 방명록에 발자국을 남겼다냥!`,
                    targetTab: 'friend'
                });
            }
        }
    });

    // 5. 전체 채팅방
    socket.on('send_global_msg', (text) => {
        const user = users[socket.id];
        if (!user) return;

        const msg = {
            id: 'gmsg_' + Date.now(),
            senderId: socket.id,
            senderName: user.nickname,
            senderPic: user.profilePic,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        globalMessages.push(msg);
        io.emit('receive_global_msg', msg);
    });

    // 6. 1:1 개인 채팅방 (핵심 버그 수정 및 룸 설정)
    socket.on('join_private_room', ({ targetId }) => {
        // 두 유저의 ID 조합으로 유일한 방 이름 생성 (정렬 기준)
        const roomName = [socket.id, targetId].sort().join('_');
        socket.join(roomName);

        // 현재 방에 해당하는 이전 메시지들만 필터링해서 전달
        const history = privateMessages.filter(m => 
            (m.senderId === socket.id && m.receiverId === targetId) ||
            (m.senderId === targetId && m.receiverId === socket.id)
        );

        // 해당 방의 상대방이 보낸 안읽은 메시지 전부 읽음 처리
        history.forEach(m => {
            if (m.receiverId === socket.id) m.unread = false;
        });

        socket.emit('private_history', history);
        // 상대방에게도 대화방에 들어왔으니 읽음 상태 업데이트하라고 알림
        io.to(roomName).emit('mark_read_realtime', { readerId: socket.id, targetId });
    });

    socket.on('leave_private_room', ({ targetId }) => {
        const roomName = [socket.id, targetId].sort().join('_');
        socket.leave(roomName);
    });

    socket.on('send_private_msg', ({ receiverId, text }) => {
        const user = users[socket.id];
        if (!user) return;

        const roomName = [socket.id, receiverId].sort().join('_');

        const msg = {
            id: 'pmsg_' + Date.now(),
            senderId: socket.id,
            senderName: user.nickname,
            senderPic: user.profilePic,
            receiverId,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            unread: true
        };

        privateMessages.push(msg);

        // 해당 룸 전체(나와 상대방 모두)에 실시간 메시지 브로드캐스트 (양방향 렌더링 보장)
        io.to(roomName).emit('receive_private_msg', msg);

        // 상대방이 룸에 없다면 별도로 1:1 메시지 알림 전달
        socket.broadcast.to(receiverId).emit('new_notification', {
            type: 'chat',
            senderId: socket.id,
            text: `🐱 ${user.nickname}님이 꾹꾹이 메시지를 보냈다냥!`,
            targetTab: 'chat'
        });
    });

    // 7. 실시간 입력 중 표시 (Typing...)
    socket.on('typing', ({ targetId, isGlobal }) => {
        const user = users[socket.id];
        if (!user) return;

        if (isGlobal) {
            socket.broadcast.emit('user_typing', { senderName: user.nickname, isGlobal: true });
        } else {
            const roomName = [socket.id, targetId].sort().join('_');
            socket.to(roomName).emit('user_typing', { senderName: user.nickname, isGlobal: false });
        }
    });

    socket.on('stop_typing', ({ targetId, isGlobal }) => {
        if (isGlobal) {
            socket.broadcast.emit('user_stop_typing', { isGlobal: true });
        } else {
            const roomName = [socket.id, targetId].sort().join('_');
            socket.to(roomName).emit('user_stop_typing', { isGlobal: false });
        }
    });

    // 접속 해제
    socket.on('disconnect', () => {
        console.log('😭 고양이 가출함:', socket.id);
        if (users[socket.id]) {
            users[socket.id].online = false;
            io.emit('update_users', Object.values(users));
            delete users[socket.id];
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🐈 깜찍뽀짝 혁찬톡 서버 가동중! http://localhost:${PORT}`);
});
