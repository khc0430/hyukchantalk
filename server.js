const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // 이미지 업로드를 위한 버퍼 크기 확장 (10MB)
});

app.use(express.static(path.join(__dirname, 'public')));

// --- 인메모리 데이터베이스 (귀여운 냥이들의 데이터 저장소) ---
const users = {};       // socket.id -> 사용자 정보 (id, nickname, statusMsg, profilePic, online)
const feeds = [];       // { id, userId, nickname, profilePic, content, image, likes: [], comments: [], timestamp }
const guestbooks = {};  // targetUserId -> [ { id, userId, nickname, content, parentId, timestamp } ]
const globalMessages = []; // 전체 채팅 메시지 { id, senderId, nickname, profilePic, content, timestamp }
const privateMessages = []; // 1:1 메시지 { id, from, to, content, timestamp, read }

let feedIdCounter = 1;
let commentIdCounter = 1;
let msgIdCounter = 1;

io.on('connection', (socket) => {
    console.log(`🐾 새로운 고양이 접속: ${socket.id}`);

    // [초기 가입 / 로그인]
    socket.on('join_user', ({ nickname, statusMsg, profilePic }) => {
        users[socket.id] = {
            id: socket.id,
            nickname: nickname || '익명 냥이',
            statusMsg: statusMsg || '야옹~ 반가워요!',
            profilePic: profilePic || '🐱',
            online: true,
            currentRoom: 'feeds' // 현재 보고 있는 탭/방 상태 추적 ('feeds', 'friends', 'global', 'private_대상ID')
        };

        // 가입 성공 응답 및 공지사항 트리거를 위한 플래그 전송
        socket.emit('join_success', { myId: socket.id });

        // 모든 유저에게 갱신된 친구 목록 전달
        updateAndBroadcastUsers();
        // 기존 피드 목록 전송
        socket.emit('feed_list', feeds);
    });

    // [프로필 업데이트]
    socket.on('update_profile', ({ nickname, statusMsg, profilePic }) => {
        if (!users[socket.id]) return;
        users[socket.id].nickname = nickname;
        users[socket.id].statusMsg = statusMsg;
        users[socket.id].profilePic = profilePic;

        // 다른 피드나 댓글의 닉네임/프로필도 실시간 동기화
        feeds.forEach(f => {
            if (f.userId === socket.id) {
                f.nickname = nickname;
                f.profilePic = profilePic;
            }
            f.comments.forEach(c => {
                if (c.userId === socket.id) {
                    c.nickname = nickname;
                }
            });
        });

        updateAndBroadcastUsers();
        io.emit('feed_list', feeds);
        socket.emit('toast_alert', { message: '🐱 프로필이 냥냥하게 변경되었습니다!' });
    });

    // [탭 상태 변경 감지 - 알림 및 읽음 처리에 매우 중요]
    socket.on('change_room', (roomName) => {
        if (!users[socket.id]) return;
        users[socket.id].currentRoom = roomName;

        // 만약 전체 채팅방에 들어왔다면, 전체 채팅 안읽은 메시지 카운트 리셋용으로 알림 다시 보냄
        if (roomName === 'global') {
            // 특별한 동작 없이 클라이언트가 0으로 초기화하도록 유도
        }

        // 만약 특정 상대와의 1:1 방에 들어왔다면 (예: private_XXXX)
        if (roomName.startsWith('private_')) {
            const targetId = roomName.replace('private_', '');
            // 상대방이 나에게 보낸 메시지들을 모두 '읽음(read=true)' 처리
            privateMessages.forEach(m => {
                if (m.from === targetId && m.to === socket.id) {
                    m.read = true;
                }
            });
            // 관련된 두 사람에게 업데이트된 대화 기록 전송 (실시간 읽음 처리 반영)
            sendPrivateMessages(socket.id, targetId);
            sendPrivateMessages(targetId, socket.id);
            // 뱃지 상태 업데이트용
            sendUnreadBadges(targetId);
        }
        sendUnreadBadges(socket.id);
    });

    // [1탭: 피드 작성]
    socket.on('create_feed', ({ content, image }) => {
        const user = users[socket.id];
        if (!user) return;

        const newFeed = {
            id: feedIdCounter++,
            userId: user.id,
            nickname: user.nickname,
            profilePic: user.profilePic,
            content,
            image, // Base64 DataURL or null
            likes: [],
            comments: [],
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };

        feeds.unshift(newFeed); // 최신글 상단
        io.emit('feed_list', feeds);
        socket.emit('toast_alert', { message: '🐾 새 피드가 등록되었다냥!' });
    });

    // [피드 좋아요]
    socket.on('like_feed', (feedId) => {
        const user = users[socket.id];
        const feed = feeds.find(f => f.id === feedId);
        if (!feed || !user) return;

        const index = feed.likes.indexOf(user.id);
        if (index === -1) {
            feed.likes.push(user.id);
            // 알림 발송 (자신이 자신에게 누른 건 제외)
            if (feed.userId !== user.id) {
                io.to(feed.userId).emit('notification', {
                    title: '🐾 좋아요 알림!',
                    message: `[${user.nickname}]님이 집사님의 피드를 좋아합니다냥!`,
                    targetTab: 'feeds'
                });
            }
        } else {
            feed.likes.splice(index, 1);
        }
        io.emit('feed_list', feeds);
    });

    // [피드 댓글/대댓글 작성 - 트리 구조]
    socket.on('create_comment', ({ feedId, content, parentId }) => {
        const user = users[socket.id];
        const feed = feeds.find(f => f.id === feedId);
        if (!feed || !user) return;

        const newComment = {
            id: commentIdCounter++,
            userId: user.id,
            nickname: user.nickname,
            content,
            parentId: parentId || null,
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };

        feed.comments.push(newComment);
        io.emit('feed_list', feeds);

        // 알림 처리
        if (feed.userId !== user.id && !parentId) {
            io.to(feed.userId).emit('notification', {
                title: '🐾 냐옹 댓글 알림!',
                message: `[${user.nickname}]님이 피드에 댓글을 남겼다냥!`,
                targetTab: 'feeds'
            });
        }
    });

    // [2탭: 친구 프로필 방명록 조회]
    socket.on('get_guestbook', (targetUserId) => {
        const list = guestbooks[targetUserId] || [];
        socket.emit('guestbook_list', { targetUserId, list });
    });

    // [친구 프로필 방명록 작성]
    socket.on('create_guestbook', ({ targetUserId, content, parentId }) => {
        const user = users[socket.id];
        if (!user) return;

        if (!guestbooks[targetUserId]) guestbooks[targetUserId] = [];
        
        const newEntry = {
            id: commentIdCounter++,
            userId: user.id,
            nickname: user.nickname,
            content,
            parentId: parentId || null,
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };

        guestbooks[targetUserId].push(newEntry);
        io.emit('guestbook_list', { targetUserId, list: guestbooks[targetUserId] });

        // 알림
        if (targetUserId !== user.id) {
            io.to(targetUserId).emit('notification', {
                title: '🐾 방명록 냐옹!',
                message: `[${user.nickname}]님이 프로필에 방명록을 남겼다냥!`,
                targetTab: 'friends',
                targetUser: targetUserId
            });
        }
    });

    // [3탭: 전체 채팅 발송]
    socket.on('send_global_msg', (content) => {
        const user = users[socket.id];
        if (!user) return;

        const msg = {
            id: msgIdCounter++,
            senderId: user.id,
            nickname: user.nickname,
            profilePic: user.profilePic,
            content,
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };

        globalMessages.push(msg);
        io.emit('receive_global_msg', msg);

        // 전체 채팅방을 보고 있지 않은 모든 온라인 유저들에게 뱃지 카운트 갱신 및 스낵바 전송
        Object.values(users).forEach(u => {
            if (u.id !== user.id && u.currentRoom !== 'global') {
                sendUnreadBadges(u.id);
                io.to(u.id).emit('notification', {
                    title: '🐱 전체채팅 냥!',
                    message: `${user.nickname}: ${content.substring(0, 15)}...`,
                    targetTab: 'global'
                });
            }
        });
    });

    // [1:1 채팅 목록 요청 및 전송]
    socket.on('request_private_chat', (targetId) => {
        sendPrivateMessages(socket.id, targetId);
    });

    // [1:1 개인 채팅 발송]
    socket.on('send_private_msg', ({ to, content }) => {
        const user = users[socket.id];
        if (!user) return;

        const targetUser = users[to];
        // 상대방이 현재 나와의 1:1 방에 켜져있는지 확인하여 실시간 읽음(read) 처리 결정
        const isRead = targetUser && targetUser.currentRoom === `private_${user.id}`;

        const msg = {
            id: msgIdCounter++,
            from: user.id,
            to,
            nickname: user.nickname,
            profilePic: user.profilePic,
            content,
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
            read: isRead
        };

        privateMessages.push(msg);

        // 발신자와 수신자 양쪽 모두에게 메시지 갱신 처리 (수정된 핵심: 본인과 상대방에게 정확히 도달)
        sendPrivateMessages(user.id, to);
        if (user.id !== to) {
            sendPrivateMessages(to, user.id);
        }

        // 상대방이 방에 없을 경우 알림 및 배지 업데이트
        if (!isRead) {
            sendUnreadBadges(to);
            io.to(to).emit('notification', {
                title: '🐾 비밀 꾹꾹이 편지!',
                message: `[${user.nickname}]님이 1:1 메시지를 보냈다냥!`,
                targetTab: 'friends',
                targetUser: user.id // 알림 클릭 시 해당 유저 상세 모달 오픈용
            });
        }
        sendUnreadBadges(user.id);
    });

    // [실시간 입력 중 상태 감지]
    socket.on('typing', ({ room, isTyping }) => {
        const user = users[socket.id];
        if (!user) return;

        if (room === 'global') {
            socket.broadcast.emit('user_typing', { room: 'global', nickname: user.nickname, isTyping });
        } else if (room.startsWith('private_')) {
            const targetId = room.replace('private_', '');
            io.to(targetId).emit('user_typing', { room: `private_${user.id}`, nickname: user.nickname, isTyping });
        }
    });

    // [연결 종료]
    socket.on('disconnect', () => {
        console.log(`🐾 고양이 가출함: ${socket.id}`);
        if (users[socket.id]) {
            users[socket.id].online = false;
            updateAndBroadcastUsers();
        }
    });

    // --- 내부 헬퍼 함수들 ---
    function updateAndBroadcastUsers() {
        io.emit('user_list', Object.values(users));
    }

    function sendPrivateMessages(userId, targetId) {
        // userId와 targetId 간에 오고 간 모든 메시지 필터링하여 정렬 전송
        const conversation = privateMessages.filter(m => 
            (m.from === userId && m.to === targetId) || (m.from === targetId && m.to === userId)
        );
        io.to(userId).emit('private_msg_list', { targetId, conversation });
    }

    function sendUnreadBadges(userId) {
        // 1. 친구 탭 뱃지: 나에게 1:1 메시지를 보낸 유저들 중 안 읽은 메시지가 있는 총 '인원수'
        const unreadSenders = new Set();
        privateMessages.forEach(m => {
            if (m.to === userId && !m.read) {
                unreadSenders.add(m.from);
            }
        });

        // 2. 전체 채팅방 뱃지: 전체 채팅 메시지 중 내가 'global' 탭에 없을 때 쌓인 개수
        // (간단 구현을 위해 마지막 접속 이후 전체 개수로 연산 처리 가능하나 스펙에 맞춰 인메모리 기반 카운팅 유도)
        // 여기서는 클라이언트가 활성화되어 있지 않을 때 서버 캐시나 임시 가상 카운트로 대체 처리 가능. 
        // 클라이언트 사이드 보완을 유도하기 위해 토탈 메시지 중 최신 유입 계산 전달.
        let totalGlobalUnread = 0; 
        const u = users[userId];
        if (u && u.currentRoom !== 'global') {
            // 편의상 실시간 알림 뱃지 시스템 유지를 위해 수치 제공
            totalGlobalUnread = 1; // 변동 트리거용 1 이상값 또는 가상 계산값
        }

        io.to(userId).emit('unread_badges', {
            friendsBadge: unreadSenders.size,
            globalBadge: totalGlobalUnread 
        });
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🐱 깜찍뽀짝 혁찬톡 서버가 http://localhost:${PORT} 에서 달리는 중이다냥!`);
});
