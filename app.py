import os
import time
from flask import Flask, render_template, request, session, redirect, url_for, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime

app = Flask(__name__)
app.secret_key = 'hyukchan_secret_key'
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///hyukchantalk.db')
if app.config['SQLALCHEMY_DATABASE_URI'].startswith("postgres://"):
    app.config['SQLALCHEMY_DATABASE_URI'] = app.config['SQLALCHEMY_DATABASE_URI'].replace("postgres://", "postgresql://", 1)
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'static/uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB limit

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Database Models
class User(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    password = db.Column(db.String(200), nullable=False)
    name = db.Column(db.String(50), nullable=False)
    status_msg = db.Column(db.String(200), default='상태 메시지를 입력하세요.')
    bio = db.Column(db.Text, default='안녕하세요! 혁찬톡에 오신 것을 환영합니다.')
    profile_pic = db.Column(db.String(200), default='https://cdn-icons-png.flaticon.com/512/149/149071.png')
    last_active = db.Column(db.Float, default=time.time)

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.String(50), db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.String(50), db.ForeignKey('user.id'), nullable=True) # Null for global chat
    text = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)

# Ensure upload directory exists
if not os.path.exists(app.config['UPLOAD_FOLDER']):
    os.makedirs(app.config['UPLOAD_FOLDER'])

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in {'png', 'jpg', 'jpeg', 'gif'}

def update_activity():
    if session.get('user_id'):
        user = User.query.get(session.get('user_id'))
        if user:
            user.last_active = time.time()
            db.session.commit()

@app.route('/')
def index():
    if not session.get('logged_in'):
        return redirect(url_for('login'))
    update_activity()
    user = User.query.get(session.get('user_id'))
    return render_template('index.html', user=user)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        user_id = request.form.get('user_id')
        password = request.form.get('password')
        user = User.query.get(user_id)
        if user and check_password_hash(user.password, password):
            session['logged_in'] = True
            session['user_id'] = user_id
            update_activity()
            return redirect(url_for('index'))
        return '<script>alert("아이디 또는 비밀번호가 틀렸습니다."); history.back();</script>'
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        user_id = request.form.get('user_id')
        password = request.form.get('password')
        if User.query.get(user_id):
            return '<script>alert("이미 존재하는 아이디입니다."); history.back();</script>'
        
        new_user = User(
            id=user_id,
            password=generate_password_hash(password),
            name=user_id
        )
        db.session.add(new_user)
        db.session.commit()
        return f'<script>alert("가입 성공!"); location.href="{url_for("login")}";</script>'
    return render_template('register.html')

@app.route('/api/profile/update', methods=['POST'])
def update_profile():
    my_id = session.get('user_id')
    if not my_id: return jsonify({'error': 'Unauthorized'}), 401
    
    user = User.query.get(my_id)
    user.name = request.form.get('name', user.name)
    user.status_msg = request.form.get('status_msg', user.status_msg)
    user.bio = request.form.get('bio', user.bio)

    if 'profile_pic' in request.files:
        file = request.files['profile_pic']
        if file and allowed_file(file.filename):
            filename = secure_filename(f"{my_id}_{int(time.time())}_{file.filename}")
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(file_path)
            user.profile_pic = f'/static/uploads/{filename}'
    
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/status')
def status_api():
    now = time.time()
    all_users = User.query.all()
    my_id = session.get('user_id')
    return jsonify([
        {
            'id': u.id, 
            'name': u.name,
            'status_msg': u.status_msg,
            'profile_pic': u.profile_pic,
            'status': "활동 중" if now - u.last_active < 60 else "비활동 중"
        }
        for u in all_users if u.id != my_id
    ])

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

# SocketIO Events
@socketio.on('join_global')
def on_join_global():
    join_room('global')
    # Load last 50 messages
    messages = Message.query.filter_by(receiver_id=None).order_by(Message.timestamp.desc()).limit(50).all()
    msg_list = [{
        'user': m.sender_id,
        'name': User.query.get(m.sender_id).name,
        'text': m.text,
        'profile_pic': User.query.get(m.sender_id).profile_pic,
        'time': m.timestamp.strftime('%H:%M')
    } for m in reversed(messages)]
    emit('init_messages', msg_list)

@socketio.on('send_global')
def on_send_global(data):
    uid = session.get('user_id')
    user = User.query.get(uid)
    new_msg = Message(sender_id=uid, text=data['text'])
    db.session.add(new_msg)
    db.session.commit()
    
    emit('new_message', {
        'user': uid,
        'name': user.name,
        'text': data['text'],
        'profile_pic': user.profile_pic,
        'time': datetime.utcnow().strftime('%H:%M')
    }, room='global')

@socketio.on('join_private')
def on_join_private(data):
    my_id = session.get('user_id')
    target_id = data['target_id']
    room = "-".join(sorted([my_id, target_id]))
    join_room(room)
    
    # Load history
    messages = Message.query.filter(
        ((Message.sender_id == my_id) & (Message.receiver_id == target_id)) |
        ((Message.sender_id == target_id) & (Message.receiver_id == my_id))
    ).order_by(Message.timestamp.desc()).limit(50).all()
    
    msg_list = [{
        'from': m.sender_id,
        'to': m.receiver_id,
        'text': m.text,
        'time': m.timestamp.strftime('%H:%M')
    } for m in reversed(messages)]
    emit('init_messages', msg_list)

@socketio.on('send_private')
def on_send_private(data):
    my_id = session.get('user_id')
    target_id = data['target_id']
    room = "-".join(sorted([my_id, target_id]))
    
    new_msg = Message(sender_id=my_id, receiver_id=target_id, text=data['text'])
    db.session.add(new_msg)
    db.session.commit()
    
    emit('new_message', {
        'from': my_id,
        'to': target_id,
        'text': data['text'],
        'time': datetime.utcnow().strftime('%H:%M')
    }, room=room)

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
