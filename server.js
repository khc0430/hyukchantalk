// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ================= [ 상남자 고양이 데이터베이스 (In-Memory) ] ================= */
const users = new Map();       // username => { username, password, nickname, bio, avatar, likedCount, online, socketId }
const feeds = [];              // Array of { id, author, content, image, likes: [], comments: [] }
const globalMessages = [];     // Array of { id, sender, text, timestamp }
const privateMessages = [];    // Array of { id, from, to, text, read, timestamp }
const notifications = [];      // Array of { id, to, text, type, targetTab, timestamp }
const guestbooks = new Map();  // username => Array of { id, author, text, parentId, timestamp }

let feedIdCounter = 1;
let msgIdCounter = 1;
let notifIdCounter = 1;
let commentIdCounter = 1;
let guestbookIdCounter = 1;

// 대한민국 시간 구하기 함수 (상남자는 ISO 따위 안 쓴다냥)
function getKSTTime() {
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstDate = new Date(now.getTime() + kstOffset);
    let hours = kstDate.getUTCHours();
    const minutes = String(kstDate.getUTCMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? '오후' : '오전';
    hours = hours % 12;
    hours = hours ? hours : 12; 
    return `${ampm} ${hours}:${minutes}`;
}

/* ================= [ Socket.io 연결 관리 ] ================= */
io.on('connection', (socket) => {
    let currentUser = null;

    // 1. 회원가입 및 로그인 (통합 처리 - 상남자는 복잡한 절차 생략한다냥)
    socket.on('auth_request', ({ username, password }) => {
        if (!username || !password) {
            socket.emit('auth_response', { success: false, message: '아이디랑 비번 똑바로 입력해라냥!' });
            return;
        }

        if (users.has(username)) {
            // 로그인 절차
            const user = users.get(username);
            if (user.password === password) {
                currentUser = user;
                currentUser.online = true;
                currentUser.socketId = socket.id;
                socket.emit('auth_response', { success: true, user: currentUser, isNew: false });
                broadcastUserList();
            } else {
                socket.emit('auth_response', { success: false, message: '비밀번호가 틀렸다냥! 등짝 스매시 맞을래냥?' });
            }
        } else {
            // 회원가입 절차
            const newUser = {
                username,
                password,
                nickname: `상남자고양이_${username}`,
                bio: '등근육 쩌는 고양이다냥.',
                avatar: '🐱',
                likedCount: 0,
                online: true,
                socketId: socket.id
            };
            users.set(username, newUser);
            currentUser = newUser;
            socket.emit('auth_response', { success: true, user: newUser, isNew: true });
            broadcastUserList();
        }
    });

    // 재접속 시 유저 정보 동기화 및 밀린 데이터 전송
    socket.on('request_sync', () => {
        if (!currentUser) return;
        socket.emit('sync_feeds', feeds);
        socket.emit('sync_global_chat', globalMessages);
        sendPrivateChatHistory();
        sendUnreadBadges();
    });

    // 2. 프로필 업데이트
    socket.on('update_profile', ({ nickname, bio, avatar }) => {
        if (!currentUser) return;
        currentUser.nickname = nickname || currentUser.nickname;
        currentUser.bio = bio || currentUser.bio;
        currentUser.avatar = avatar || currentUser.avatar;
        
        socket.emit('profile_updated', currentUser);
        broadcastUserList();
    });

    // 3. 피드 작성 (이미지 포함 가능)
    socket.on('create_feed', ({ content, image }) => {
        if (!currentUser) return;
        const newFeed = {
            id: feedIdCounter++,
            author: currentUser.username,
            nickname: currentUser.nickname,
            avatar: currentUser.avatar,
            content,
            image: image || null,
            likes: [],
            comments: []
        };
        feeds.unshift(newFeed); // 최신글 상단
        io.emit('sync_feeds', feeds);
    });

    // 피드 좋아요
    socket.on('like_feed', (feedId) => {
        if (!currentUser) return;
        const feed = feeds.find(f => f.id === feedId);
        if (feed) {
            const idx = feed.likes.indexOf(currentUser.username);
            if (idx === -1) {
                feed.likes.push(currentUser.username);
                // 알림 생성 (본인 글 제외)
                if (feed.author !== currentUser.username) {
                    createNotification(feed.author, `🔥 ${currentUser.nickname}님이 네 피드를 좋아한다냥!`, 'feed');
                }
            } else {
                feed.likes.splice(idx, 1);
            }
            io.emit('sync_feeds', feeds);
        }
    });

    // 피드 댓글/대댓글 작성 (트리 구조)
    socket.on('comment_feed', ({ feedId, parentId, text }) => {
        if (!currentUser) return;
        const feed = feeds.find(f => f.id === feedId);
        if (feed) {
            const newComment = {
                id: commentIdCounter++,
                parentId: parentId || null,
                author: currentUser.username,
                nickname: currentUser.nickname,
                text,
                timestamp: getKSTTime()
            };
            feed.comments.push(newComment);
            io.emit('sync_feeds', feeds);

            if (feed.author !== currentUser.username && !parentId) {
                createNotification(feed.author, `💬 ${currentUser.nickname}님이 네 피드에 댓글 달았다냥!`, 'feed');
            }
        }
    });

    // 4. 친구 상세 조회 및 방명록
    socket.on('get_friend_detail', (targetUsername) => {
        const target = users.get(targetUsername);
        if (!target) return;
        const posts = guestbooks.get(targetUsername) || [];
        socket.emit('friend_detail_response', { target, guestbook: posts });
    });

    socket.on('like_friend', (targetUsername) => {
        const target = users.get(targetUsername);
        if (!target) return;
        target.likedCount = (target.likedCount || 0) + 1;
        createNotification(targetUsername, `💖 ${currentUser.nickname}님이 네 프로필을 좋아한다냥!`, 'friend');
        
        const posts = guestbooks.get(targetUsername) || [];
        socket.emit('friend_detail_response', { target, guestbook: posts });
        broadcastUserList();
    });

    socket.on('write_guestbook', ({ targetUsername, parentId, text }) => {
        if (!currentUser) return;
        if (!guestbooks.has(targetUsername)) {
            guestbooks.set(targetUsername, []);
        }
        const posts = guestbooks.get(targetUsername);
        const newPost = {
            id: guestbookIdCounter++,
            parentId: parentId || null,
            author: currentUser.username,
            nickname: currentUser.nickname,
            text,
            timestamp: getKSTTime()
        };
        posts.push(newPost);
        
        const target = users.get(targetUsername);
        io.emit('friend_detail_response', { target, guestbook: posts });
        if (targetUsername !== currentUser.username) {
            createNotification(targetUsername, `🐾 ${currentUser.nickname}님이 방명록을 남겼다냥!`, 'friend');
        }
    });

    // 5. 전체 채팅방
    socket.on('send_global_msg', (text) => {
        if (!currentUser) return;
        const msg = {
            id: msgIdCounter++,
            sender: currentUser.username,
            nickname: currentUser.nickname,
            avatar: currentUser.avatar,
            text,
            timestamp: getKSTTime()
        };
        globalMessages.push(msg);
        io.emit('new_global_msg', msg);
        
        // 다른 접속자들에게 전체채팅방 안 읽음 카운트 갱신용 브로드캐스트
        users.forEach(u => {
            if (u.username !== currentUser.username) {
                const targetSocket = io.sockets.sockets.get(u.socketId);
                if (targetSocket) {
                    targetSocket.emit('bump_global_badge');
                }
            }
        });
    });

    // 6. 1:1 개인 채팅방 & 실시간 읽음 처리
    socket.on('send_private_msg', ({ to, text }) => {
        if (!currentUser) return;
        const targetUser = users.get(to);
        
        // 상대방이 현재 나와의 1:1 대화방을 열고 있는지 여부 체크
        // 클라이언트가 activeChatTarget 프로퍼티로 판별할 수 있도록 실시간 동기화
        const isTargetReading = targetUser && targetUser.online && targetUser.activeChatTarget === currentUser.username;

        const msg = {
            id: msgIdCounter++,
            from: currentUser.username,
            to,
            text,
            read: !!isTargetReading,
            timestamp: getKSTTime()
        };
        privateMessages.push(msg);

        // 보낸 사람 전송 완료
        socket.emit('new_private_msg', msg);

        // 받는 사람 처리
        if (targetUser && targetUser.online) {
            const targetSocket = io.sockets.sockets.get(targetUser.socketId);
            if (targetSocket) {
                targetSocket.emit('new_private_msg', msg);
                if (!isTargetReading) {
                    targetSocket.emit('bump_private_badge', currentUser.username);
                    createNotification(to, `✉️ ${currentUser.nickname}님이 비밀 메시지를 보냈다냥!`, 'chat');
                }
            }
        }
    });

    // 현재 열고 있는 대화방 상태 업데이트 (읽음 처리용 핵심 로직)
    socket.on('set_active_chat', (targetUsername) => {
        if (!currentUser) return;
        currentUser.activeChatTarget = targetUsername;
        
        if (targetUsername) {
            // 상대방이 나에게 보낸 메시지 전부 읽음 처리
            privateMessages.forEach(msg => {
                if (msg.from === targetUsername && msg.to === currentUser.username) {
                    msg.read = true;
                }
            });
            // 상대방에게도 다 읽었다고 통보해서 실시간으로 '1'을 지움
            const targetUser = users.get(targetUsername);
            if (targetUser && targetUser.online) {
                const targetSocket = io.sockets.sockets.get(targetUser.socketId);
                if (targetSocket) {
                    targetSocket.emit('private_msgs_read_fallback', currentUser.username);
                }
            }
        }
        sendPrivateChatHistory();
        sendUnreadBadges();
    });

    // 7. 실시간 입력 중 표시 (Typing)
    socket.on('typing_status', ({ to, isTyping, isGlobal }) => {
        if (!currentUser) return;
        if (isGlobal) {
            socket.broadcast.emit('global_typing_status', { nickname: currentUser.nickname, isTyping });
        } else if (to) {
            const targetUser = users.get(to);
            if (targetUser && targetUser.online) {
                const targetSocket = io.sockets.sockets.get(targetUser.socketId);
                if (targetSocket) {
                    targetSocket.emit('private_typing_status', { from: currentUser.username, nickname: currentUser.nickname, isTyping });
                }
            }
        }
    });

    // 알림 생성 및 발송 공통 유틸 함수
    function createNotification(toUsername, text, targetTab) {
        const notif = {
            id: notifIdCounter++,
            to: toUsername,
            text,
            targetTab,
            timestamp: getKSTTime()
        };
        notifications.push(notif);
        const target = users.get(toUsername);
        if (target && target.online) {
            const targetSocket = io.sockets.sockets.get(target.socketId);
            if (targetSocket) {
                targetSocket.emit('live_notification', notif);
            }
        }
    }

    function broadcastUserList() {
        const list = Array.from(users.values()).map(u => ({
            username: u.username,
            nickname: u.nickname,
            bio: u.bio,
            avatar: u.avatar,
            online: u.online,
            likedCount: u.likedCount || 0
        }));
        io.emit('user_list', list);
    }

    function sendPrivateChatHistory() {
        if (!currentUser) return;
        const history = privateMessages.filter(m => m.from === currentUser.username || m.to === currentUser.username);
        socket.emit('sync_private_chat', history);
    }

    function sendUnreadBadges() {
        if (!currentUser) return;
        // 나에게 온 메시지 중 안 읽은 대화 상대방의 '인원수' 계산
        const unreadSenders = new Set();
        privateMessages.forEach(m => {
            if (m.to === currentUser.username && !m.read) {
                unreadSenders.add(m.from);
            }
        });
        socket.emit('update_badges', { privateCount: unreadSenders.size });
    }

    // 연결 종료 처리
    socket.on('disconnect', () => {
        if (currentUser) {
            currentUser.online = false;
            currentUser.activeChatTarget = null;
            broadcastUserList();
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🐱 고양이 메신저 [혁찬톡] 서버 가동! http://localhost:${PORT}`);
});
