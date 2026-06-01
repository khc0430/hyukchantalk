const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 인메모리 데이터베이스 ---
const users = {};       // socket.id => { id, nickname, statusMsg, profilePic, online: true, currentRoom: 'global' }
const feeds = [];       // { id, authorId, authorName, authorPic, content, image, likes: [], comments: [], timestamp }
const globalMessages = []; // { id, senderId, senderName, senderPic, text, timestamp }
const directMessages = []; // { id, from, to, text, timestamp, read: false }
const profileGuestbooks = {}; // userId => [ { id, authorId, authorName, content, timestamp, comments: [] } ]
const profileLikes = {};    // userId => [ selectorUserIds... ]

let feedIdCounter = 1;
let commentIdCounter = 1;
let dmIdCounter = 1;
let msgIdCounter = 1;

io.on('connection', (socket) => {
    // 1. 초기 입장 / 회원가입 처리
    socket.on('join', (userData) => {
        const userId = userData.id || 'user_' + Math.random().toString(36).substr(2, 9);
        
        // 기존 유저 정보가 없으면 신규 생성
        if (!users[userId]) {
            users[userId] = {
                id: userId,
                nickname: userData.nickname || '귀여운 집사',
                statusMsg: userData.statusMsg || '야옹~ 반가워요!',
                profilePic: userData.profilePic || '🐱',
                online: true,
                currentRoom: 'global',
                isNewUser: true // 최초 공지창 띄우기 용도
            };
        } else {
            users[userId].online = true;
            users[userId].currentRoom = 'global';
        }

        socket.userId = userId;
        socket.join('global');

        // 내 정보 전송 (최초 가입 여부 포함)
        socket.emit('init_self', users[userId]);
        users[userId].isNewUser = false; // 한 번 보낸 후 플래그 해제

        // 전체 유저 리스트 및 피드 리스트 갱신 알림
        io.emit('update_users', Object.values(users));
        socket.emit('update_feeds', feeds);
        socket.emit('init_global_chat', globalMessages);
    });

    // 프로필 및 스태터스 업데이트
    socket.on('update_profile', (data) => {
        if (!socket.userId || !users[socket.userId]) return;
        users[socket.userId].nickname = data.nickname;
        users[socket.userId].statusMsg = data.statusMsg;
        users[socket.userId].profilePic = data.profilePic;

        io.emit('update_users', Object.values(users));
        // 피드 내 작성자 정보 최신화를 위해 피드 리스트 다시 전송
        feeds.forEach(f => {
            if(f.authorId === socket.userId) {
                f.authorName = data.nickname;
                f.authorPic = data.profilePic;
            }
        });
        io.emit('update_feeds', feeds);
    });

    // 2. 피드 기능
    socket.on('create_feed', (data) => {
        if (!socket.userId) return;
        const user = users[socket.userId];
        const newFeed = {
            id: feedIdCounter++,
            authorId: user.id,
            authorName: user.nickname,
            authorPic: user.profilePic,
            content: data.content,
            image: data.image || null,
            likes: [],
            comments: [],
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };
        feeds.unshift(newFeed);
        io.emit('update_feeds', feeds);
    });

    socket.on('like_feed', (feedId) => {
        const feed = feeds.find(f => f.id === feedId);
        if (feed && socket.userId) {
            const index = feed.likes.indexOf(socket.userId);
            if (index === -1) {
                feed.likes.push(socket.userId);
                // 알림 발송 (자신이 아닐 때만)
                if (feed.authorId !== socket.userId) {
                    sendNotification(feed.authorId, `🐾 ${users[socket.userId].nickname}님이 내 피드를 좋아합니다!`, 'feed');
                }
            } else {
                feed.likes.splice(index, 1);
            }
            io.emit('update_feeds', feeds);
        }
    });

    socket.on('comment_feed', (data) => {
        const feed = feeds.find(f => f.id === data.feedId);
        if (feed && socket.userId) {
            const user = users[socket.userId];
            const newComment = {
                id: commentIdCounter++,
                parentId: data.parentId || null,
                authorId: user.id,
                authorName: user.nickname,
                authorPic: user.profilePic,
                content: data.content,
                timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
            };
            feed.comments.push(newComment);
            io.emit('update_feeds', feeds);

            if (feed.authorId !== socket.userId) {
                sendNotification(feed.authorId, `💬 ${user.nickname}님이 내 피드에 댓글을 달았습니다!`, 'feed');
            }
        }
    });

    // 3. 친구 상세 프로필 (좋아요 / 방명록)
    socket.on('get_profile_detail', (targetId) => {
        if (!users[targetId]) return;
        const guestbook = profileGuestbooks[targetId] || [];
        const likes = profileLikes[targetId] || [];
        socket.emit('profile_detail_data', {
            targetId,
            likes,
            guestbook
        });
    });

    socket.on('like_profile', (targetId) => {
        if (!socket.userId) return;
        if (!profileLikes[targetId]) profileLikes[targetId] = [];
        const idx = profileLikes[targetId].indexOf(socket.userId);
        if (idx === -1) {
            profileLikes[targetId].push(socket.userId);
            sendNotification(targetId, `❤️ ${users[socket.userId].nickname}님이 내 프로필을 좋아합니다!`, 'friend');
        } else {
            profileLikes[targetId].splice(idx, 1);
        }
        // 갱신 데이터 반환
        socket.emit('profile_detail_data', {
            targetId,
            likes: profileLikes[targetId],
            guestbook: profileGuestbooks[targetId] || []
        });
    });

    socket.on('comment_profile', (data) => {
        const { targetId, content, parentId } = data;
        if (!socket.userId) return;
        if (!profileGuestbooks[targetId]) profileGuestbooks[targetId] = [];

        const user = users[socket.userId];
        const newComment = {
            id: commentIdCounter++,
            parentId: parentId || null,
            authorId: user.id,
            authorName: user.nickname,
            content: content,
            timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        };

        profileGuestbooks[targetId].push(newComment);
        
        io.emit('update_users', Object.values(users));
        socket.emit('profile_detail_data', {
            targetId,
            likes: profileLikes[targetId] || [],
            guestbook: profileGuestbooks[targetId]
        });

        sendNotification(targetId, `🐾 ${user.nickname}님이 방명록을 남겼습니다!`, 'friend');
    });

    // 4. 채팅방 입장 및 전환 로직 (룸 관리)
    socket.on('switch_room', (targetRoom) => {
        if (!socket.userId) return;
        
        // 이전 룸 나가기
        socket.leave(users[socket.userId].currentRoom);
        users[socket.userId].currentRoom = targetRoom;
        socket.join(targetRoom);

        if (targetRoom === 'global') {
            socket.emit('init_global_chat', globalMessages);
        } else if (targetRoom.startsWith('dm_')) {
            // 상대방과의 DM 내용 필터링 추출
            const targetUserId = targetRoom.replace('dm_', '');
            
            // 내 방
