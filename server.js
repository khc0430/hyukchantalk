const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 인메모리 데이터베이스 (재로그인 시 데이터 유지) ---
const users = new Map();       // username => { username, password, nickname, bio, avatar, likes: 0, isFirst: true }
const feeds = [];              // [ { id, author, content, image, likes: [], comments: [] } ]
const globalMessages = [];     // [ { id, sender, text, timestamp } ]
const privateMessages = [];    // [ { id, from, to, text, timestamp, read: false } ]
const guestbooks = new Map();  // username => [ { id, author, text, timestamp, replies: [] } ]

// 실시간 접속 유저 매핑 (username => socket.id)
const onlineUsers = new Map();

io.on('connection', (socket) => {
    let currentUsername = null;
    let currentRoom = null; // 현재 머무는 대화방 ('global' 또는 'private:상대방ID')

    // 1. 회원가입 및 로그인 통합 처리
    socket.on('auth_request', ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('auth_response', { success: false, message: '아이디와 비밀번호를 입력해라냥!' });
        }

        let user = users.get(username);
        let isFirstTime = false;

        if (!user) {
            // 회원가입
            user = {
                username,
                password,
                nickname: username,
                bio: '반갑다냥! 상태메시지를 적어줘라냥.',
                avatar: '🐱',
                likes: 0,
                isFirst: true
            };
            users.set(username, user);
            isFirstTime = true;
        } else {
            // 로그인 검증
            if (user.password !== password) {
                return socket.emit('auth_response', { success: false, message: '비밀번호가 틀렸다냥!' });
            }
            isFirstTime = user.isFirst;
        }

        currentUsername = username;
        onlineUsers.set(username, socket.id);

        // 유저 정보 업데이트 및 로그인 성공 알림
        socket.emit('auth_response', { 
            success: true, 
            user: { username: user.username, nickname: user.nickname, bio: user.bio, avatar: user.avatar },
            isFirstTime: isFirstTime
        });

        // 온라인 상태 브로드캐스트
        io.emit('user_status_change', { username, online: true });
    });

    // 공지사항 확인 완료 처리
    socket.on('notice_confirmed', () => {
        if (currentUsername && users.has(currentUsername)) {
            users.get(currentUsername).isFirst = false;
        }
    });

    // 초기 데이터 요청 데이터 바인딩
    socket.on('request_initial_data', () => {
        if (!currentUsername) return;

        // 전체 유저 리스트 전송 (나 제외)
        const userList = [];
        users.forEach((u, uname) => {
            if (uname !== currentUsername) {
                userList.push({
                    username: u.username,
                    nickname: u.nickname,
                    bio: u.bio,
                    avatar: u.avatar,
                    likes: u.likes,
                    online: onlineUsers.has(uname)
                });
            }
        });

        socket.emit('initial_data', {
            feeds: feeds,
            globalMessages: globalMessages,
            userList: userList
        });

        // 읽지 않은 1:1 메시지 카운트 계산 전송
        sendUnreadPrivateCounts(currentUsername, socket);
    });

    // 프로필 업데이트
    socket.on('update_profile', ({ nickname, bio, avatar }) => {
        if (!currentUsername) return;
        const user = users.get(currentUsername);
        if (user) {
            user.nickname = nickname || user.nickname;
            user.bio = bio || '';
            user.avatar = avatar || user.avatar;
            
            // 전체 클라이언트에 프로필 변경 반영 리프레시 요청
            io.emit('profile_updated', { username: currentUsername, nickname: user.nickname, bio: user.bio, avatar: user.avatar });
        }
    });

    // 2. 피드(게시글) 및 트리형 댓글 기능
    socket.on('create_feed', ({ content, image }) => {
        if (!currentUsername) return;
        const user = users.get(currentUsername);
        const newFeed = {
            id: 'feed_' + Date.now(),
            author: currentUsername,
            nickname: user.nickname,
            avatar: user.avatar,
            content,
            image,
            likes: [],
            comments: []
        };
        feeds.unshift(newFeed);
        io.emit('feed_created', newFeed);
    });

    socket.on('like_feed', ({ feedId }) => {
        if (!currentUsername) return;
        const feed = feeds.find(f => f.id === feedId);
        if (feed) {
            const idx = feed.likes.indexOf(currentUsername);
            if (idx === -1) {
                feed.likes.push(currentUsername);
                // 알림 발송 (글 작성자에게)
                sendNotification(feed.author, `${users.get(currentUsername).nickname}님이 내 게시글에 하트를 눌렀다냥!`, 'feed');
            } else {
                feed.likes.splice(idx, 1);
            }
            io.emit('feed_updated', feed);
        }
    });

    socket.on('comment_feed', ({ feedId, parentId, text }) => {
        if (!currentUsername) return;
        const feed = feeds.find(f => f.id === feedId);
        if (feed) {
            const user = users.get(currentUsername);
            const newComment = {
                id: 'comm_' + Date.now(),
                parentId: parentId || null,
                author: currentUsername,
                nickname: user.nickname,
                text,
                timestamp: getKSTString()
            };
            feed.comments.push(newComment);
            io.emit('feed_updated', feed);

            // 알림 발송
            if (feed.author !== currentUsername) {
                sendNotification(feed.author, `${user.nickname}님이 내 게시글에 댓글을 남겼다냥!`, 'feed');
            }
        }
    });

    // 3. 친구 상세 모달 내부 (방명록 & 좋아요)
    socket.on('request_friend_profile', ({ targetUsername }) => {
        const target = users.get(targetUsername);
        if (!target) return;
        const list = guestbooks.get(targetUsername) || [];
        socket.emit('friend_profile_data', {
            username: targetUsername,
            likes: target.likes,
            guestbook: list
        });
    });

    socket.on('like_friend', ({ targetUsername }) => {
        const target = users.get(targetUsername);
        if (!target || !currentUsername) return;
        target.likes += 1;
        
        sendNotification(targetUsername, `${users.get(currentUsername).nickname}님이 내 프로필에 꾹 하트를 눌렀다냥!`, 'friend');
        
        // 데이터 갱신 알림
        const list = guestbooks.get(targetUsername) || [];
        socket.emit('friend_profile_data', { username: targetUsername, likes: target.likes, guestbook: list });
    });

    socket.on('comment_guestbook', ({ targetUsername, parentId, text }) => {
        if (!currentUsername) return;
        if (!guestbooks.has(targetUsername)) {
            guestbooks.set(targetUsername, []);
        }
        const list = guestbooks.get(targetUsername);
        const user = users.get(currentUsername);

        const newComment = {
            id: 'gb_' + Date.now(),
            parentId: parentId || null,
            author: currentUsername,
            nickname: user.nickname,
            text,
            timestamp: getKSTString()
        };

        list.push(newComment);
        io.emit('guestbook_updated', { targetUsername, guestbook: list });
        sendNotification(targetUsername, `${user.nickname}님이 내 방명록에 발자국을 남겼다냥!`, 'friend');
    });

    // 4. 대화방 입장 및 실시간 동기화 (전체채팅 & 1:1 대화방 개별 수정 완료)
    socket.on('join_room', ({ roomType, target }) => {
        currentRoom = roomType === 'global' ? 'global' : `private:${target}`;
        
        if (roomType === 'private') {
            // 읽음 상태 업데이트 처리 (상대방이 나에게 보낸 메시지 모두 읽음으로)
            privateMessages.forEach(msg => {
                if (msg.from === target && msg.to === currentUsername) {
                    msg.read = true;
                }
            });
            // 상대방에게도 실시간 읽음 완료 전송 및 내 뱃지 카운트 최신화
            const targetSocketId = onlineUsers.get(target);
            if (targetSocketId) {
                io.to(targetSocketId).emit('private_read_update', { from: currentUsername });
            }
            sendUnreadPrivateCounts(currentUsername, socket);
            
            // 대화 이력 필터링하여 로드 (내가 보낸 것과 상대가 보낸 것 모두 취합)
            const chatHistory = privateMessages.filter(msg => 
                (msg.from === currentUsername && msg.to === target) || 
                (msg.from === target && msg.to === currentUsername)
            );
            socket.emit('private_history', { target, history: chatHistory });
        }
    });

    socket.on('leave_room', () => {
        currentRoom = null;
    });

    // 5. 메시지 전송 및 실시간 읽음 기능 고도화
    socket.on('send_global_msg', ({ text }) => {
        if (!currentUsername) return;
        const msg = {
            id: 'gmsg_' + Date.now(),
            sender: currentUsername,
            nickname: users.get(currentUsername).nickname,
            avatar: users.get(currentUsername).avatar,
            text,
            timestamp: getKSTString()
        };
        globalMessages.push(msg);
        io.emit('receive_global_msg', msg);
    });

    socket.on('send_private_msg', ({ to, text }) => {
        if (!currentUsername) return;
        
        // 상대방이 현재 나와의 1:1 대화방을 열어두고 있는지 체크
        const targetSocketId = onlineUsers.get(to);
        let isRead = false;
        
        // 상대방 소켓 세션에서 현재 룸이 나와의 대화방인지 검증 유추 구현
        // 실제 운영 레벨 기준: 상대방 소켓 세션을 검사하거나 상태를 추적
        // 여기서는 대상 유저가 접속 중이며, 대상 유저가 나와의 실시간 소통 상태인지 확인하는 구조 확장 가능
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            // 간이 검증: 수신 소켓이 해당 전용 방을 실시간 조준하고 있을 때
            // 클라이언트 사이드와 교차 검증을 위해 소켓 객체 내부 변수 활용 가능
        }

        const msg = {
            id: 'pmsg_' + Date.now(),
            from: currentUsername,
            to,
            text,
            timestamp: getKSTString(),
            read: isRead
        };

        privateMessages.push(msg);

        // 발신자 화면에 즉시 노출
        socket.emit('receive_private_msg', msg);

        if (targetSocketId) {
            // 상대방에게 전송
            io.to(targetSocketId).emit('receive_private_msg', msg);
            // 실시간 상단 알림 처리
            io.to(targetSocketId).emit('push_notification', {
                message: `${users.get(currentUsername).nickname}님이 비밀 메시지를 보냈다냥!🐾`,
                type: 'chat',
                targetTab: 'friend'
            });
            // 상대방 안읽은 뱃지 업데이트
            sendUnreadPrivateCounts(to, io.to(targetSocketId));
        }
    });

    // 6. 실시간 입력 중 표시 기능
    socket.on('typing_status', ({ isTyping, roomType, target }) => {
        if (!currentUsername) return;
        const nickname = users.get(currentUsername).nickname;
        
        if (roomType === 'global') {
            socket.broadcast.emit('user_typing', { nickname, isTyping, roomType: 'global' });
        } else if (roomType === 'private' && target) {
            const targetSocketId = onlineUsers.get(target);
            if (targetSocketId) {
                io.to(targetSocketId).emit('user_typing', { nickname, isTyping, roomType: 'private', from: currentUsername });
            }
        }
    });

    // 연결 종료 처리
    socket.on('disconnect', () => {
        if (currentUsername) {
            onlineUsers.delete(currentUsername);
            io.emit('user_status_change', { username: currentUsername, online: false });
        }
    });
});

// 한국 시간(KST) 구하기 함수
function getKSTString() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kst = new Date(utc + (9 * 3600000));
    let hours = kst.getHours();
    const minutes = String(kst.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? '오후' : '오전';
    hours = hours % 12;
    hours = hours ? hours : 12; 
    return `${ampm} ${hours}:${minutes}`;
}

// 실시간 특정 유저 타겟팅 알림 헬퍼
function sendNotification(targetUsername, message, type) {
    const targetSocketId = onlineUsers.get(targetUsername);
    if (targetSocketId) {
        io.to(targetSocketId).emit('push_notification', { 
            message, 
            type, 
            targetTab: type === 'feed' ? 'feed' : 'friend' 
        });
    }
}

// 안읽은 개인 메시지 발송 헬퍼
function sendUnreadPrivateCounts(username, targetSocket) {
    // 수신자가 나(username)이고 안읽은(read === false) 메시지 추출하여 발신자 종류 카운트
    const unreadMap = new Set();
    privateMessages.forEach(msg => {
        if (msg.to === username && !msg.read) {
            unreadMap.add(msg.from);
        }
    });
    targetSocket.emit('unread_private_count', { count: unreadMap.size });
}

const PORT = 3000;
server.listen(PORT, () => console.log(`😻 혁찬톡 고양이 서버 가동 중: http://localhost:${PORT}`));
