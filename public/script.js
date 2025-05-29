// public/script.js
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const roomSelect = document.getElementById('room-select'); // Pode não ser usado diretamente, mas mantido
const createRoomButton = document.getElementById('create-room-button');
const newRoomInput = document.getElementById('new-room-input');
const roomList = document.getElementById('room-list'); // Ul ou Div para a lista de salas
const currentRoomSpan = document.getElementById('current-room');
const audioRecordButton = document.getElementById('audio-record-button');

// Seus elementos de login/registro
const registerForm = document.getElementById('register-form');
const loginForm = document.getElementById('login-form');

// URLs do Backend
// Para TESTE LOCAL: use "http://localhost:3000"
// Para PRODUÇÃO (Render): use a URL do seu backend no Render (ex: "https://thenewera.onrender.com")
const BACKEND_BASE_URL = "http://localhost:3000"; 
const SIGNALING_SERVER_URL = BACKEND_BASE_URL; // A URL do seu servidor de sinalização (que é o backend)

const socket = io(SIGNALING_SERVER_URL, { transports: ['websocket', 'polling'] });

// --- Variáveis WebRTC ---
const peerConnections = {}; // { [remoteSocketId]: RTCPeerConnection }
const remoteStreams = {};   // { [remoteSocketId]: MediaStream } para cada stream de vídeo/áudio remoto
let localStream;            // Seu stream de áudio/vídeo local
let mediaRecorder;          // Para gravação de áudio
let audioChunks = [];       // Para armazenar chunks de áudio gravado

// --- Funções Auxiliares ---

function getUsername() {
    return localStorage.getItem('username');
}

function setUsername(username) {
    localStorage.setItem('username', username);
}

function displayMessage(username, message, room, type = 'text', audioBlob = null) {
    const div = document.createElement('div');
    div.classList.add('message');
    const timestamp = new Date().toLocaleTimeString();

    const usernameSpan = document.createElement('span');
    usernameSpan.classList.add('username');
    usernameSpan.textContent = `${username} [${room}]: `;

    const contentSpan = document.createElement('span');
    contentSpan.classList.add('content');

    if (type === 'text') {
        contentSpan.textContent = message;
    } else if (type === 'audio' && audioBlob) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = URL.createObjectURL(audioBlob);
        contentSpan.appendChild(audio);
    }

    const timestampSpan = document.createElement('span');
    timestampSpan.classList.add('timestamp');
    timestampSpan.textContent = ` (${timestamp})`;

    div.appendChild(usernameSpan);
    div.appendChild(contentSpan);
    div.appendChild(timestampSpan);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
}

function updateRoomList(rooms) {
    roomList.innerHTML = ''; // Limpa a lista atual
    rooms.forEach(room => {
        const li = document.createElement('li');
        li.textContent = room;
        li.classList.add('room-item');
        if (room === currentRoomSpan.textContent) {
            li.classList.add('active');
        }
        li.addEventListener('click', () => {
            socket.emit('join-room', room);
        });
        roomList.appendChild(li);
    });
}

// --- Funções WebRTC ---

async function startLocalStream() {
    if (localStream) return localStream; // Já iniciado

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            localVideo.srcObject = localStream;
        }
        console.log("Stream local iniciado com sucesso.");
        return localStream;
    } catch (err) {
        console.error("Erro ao acessar câmera/microfone: ", err);
        alert("Não foi possível acessar sua câmera ou microfone. Por favor, permita o acesso e recarregue a página.");
        return null;
    }
}

function createPeerConnection(remoteSocketId) {
    if (peerConnections[remoteSocketId]) {
        console.warn(`PeerConnection para ${remoteSocketId} já existe.`);
        return peerConnections[remoteSocketId];
    }

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] // Servidores STUN
    });

    // Adiciona o stream local à nova conexão
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        console.log(`Tracks locais adicionados para peer ${remoteSocketId}`);
    } else {
        console.warn(`Local stream não disponível para adicionar ao peer ${remoteSocketId}`);
    }

    // Evento para enviar ICE Candidates (endereços de rede)
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`[WebRTC] Enviando ICE Candidate para ${remoteSocketId}`);
            socket.emit('iceCandidate', {
                targetSocketId: remoteSocketId,
                candidate: event.candidate
            });
        }
    };

    // Evento para receber streams remotos (vídeo/áudio do outro peer)
    pc.ontrack = (event) => {
        console.log(`[WebRTC] Recebido track de ${remoteSocketId}`);
        // Verifique se o stream já foi adicionado
        if (remoteStreams[remoteSocketId] && remoteStreams[remoteSocketId] === event.streams[0]) {
             console.log(`Stream já existe para ${remoteSocketId}, ignorando track duplicado.`);
             return;
        }

        remoteStreams[remoteSocketId] = event.streams[0]; // Armazena o stream
        
        let remoteVideoElement = document.getElementById(`remoteVideo-${remoteSocketId}`);
        if (!remoteVideoElement) {
            const videoContainer = document.getElementById('remoteVideosContainer');
            remoteVideoElement = document.createElement('video');
            remoteVideoElement.id = `remoteVideo-${remoteSocketId}`;
            remoteVideoElement.autoplay = true;
            remoteVideoElement.playsInline = true;
            remoteVideoElement.controls = true; // Para depuração
            remoteVideoElement.muted = false; // Não mude por padrão, a menos que seja para feedback
            remoteVideoElement.classList.add('remote-video-feed'); // Adicione uma classe para estilização
            videoContainer.appendChild(remoteVideoElement);
            console.log(`Elemento de vídeo para ${remoteSocketId} criado e adicionado.`);
        }
        remoteVideoElement.srcObject = event.streams[0];
        console.log(`Stream remoto definido para ${remoteSocketId}.`);
    };

    // Monitora o estado da conexão WebRTC
    pc.onconnectionstatechange = () => {
        console.log(`PeerConnection com ${remoteSocketId} state: ${pc.connectionState}`);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            console.log(`Conexão com ${remoteSocketId} perdida. Fechando e limpando.`);
            // A limpeza é feita principalmente pelo 'userLeft' do Socket.IO, mas podemos adicionar redundância aqui
            if (peerConnections[remoteSocketId]) {
                 peerConnections[remoteSocketId].close();
                 delete peerConnections[remoteSocketId];
            }
            const remoteVideoElement = document.getElementById(`remoteVideo-${remoteSocketId}`);
            if (remoteVideoElement) {
                remoteVideoElement.remove();
            }
            delete remoteStreams[remoteSocketId];
        }
    };

    peerConnections[remoteSocketId] = pc;
    return pc;
}

// --- Listeners de Socket.IO ---

socket.on('connect', () => {
    console.log('Conectado ao servidor de sinalização com ID:', socket.id);
    // Não chame set-username aqui diretamente, espere o login/registro
});

socket.on('disconnect', () => {
    console.log('Desconectado do servidor de sinalização.');
    // Feche todas as peer connections existentes
    for (const id in peerConnections) {
        if (peerConnections[id]) {
            peerConnections[id].close();
            const videoElement = document.getElementById(`remoteVideo-${id}`);
            if (videoElement) videoElement.remove();
        }
    }
    Object.keys(peerConnections).forEach(key => delete peerConnections[key]);
    Object.keys(remoteStreams).forEach(key => delete remoteStreams[key]);
});


socket.on('userJoined', async (remoteSocketId) => {
    if (remoteSocketId === socket.id) return; // Não se conecte a si mesmo

    console.log(`[Socket.IO] Um novo usuário (${remoteSocketId}) se juntou à sala. Iniciando PeerConnection.`);
    
    // Inicia o stream local se ainda não estiver ativo
    await startLocalStream();

    const pc = createPeerConnection(remoteSocketId);

    // Cria e envia a OFERTA para o novo peer
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`[WebRTC] Enviando oferta para ${remoteSocketId}`);
        socket.emit('offer', {
            targetSocketId: remoteSocketId,
            sdp: pc.localDescription
        });
    } catch (error) {
        console.error(`Erro ao criar oferta para ${remoteSocketId}:`, error);
    }
});

socket.on('userLeft', (remoteSocketId) => {
    console.log(`[Socket.IO] Usuário (${remoteSocketId}) saiu da sala.`);
    if (peerConnections[remoteSocketId]) {
        peerConnections[remoteSocketId].close();
        delete peerConnections[remoteSocketId];
        // Remova o elemento de vídeo correspondente
        const remoteVideoElement = document.getElementById(`remoteVideo-${remoteSocketId}`);
        if (remoteVideoElement) {
            remoteVideoElement.remove();
        }
        delete remoteStreams[remoteSocketId];
    }
});

socket.on('offer', async (data) => {
    const { sdp, senderId } = data;
    console.log(`[WebRTC] Recebida oferta de ${senderId}`);

    // Inicia o stream local se ainda não estiver ativo
    await startLocalStream();
    
    // Cria a PeerConnection se ainda não existir
    const pc = createPeerConnection(senderId);

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log(`[WebRTC] Enviando resposta para ${senderId}`);
        socket.emit('answer', {
            targetSocketId: senderId,
            sdp: pc.localDescription
        });
    } catch (error) {
        console.error(`Erro ao processar oferta de ${senderId}:`, error);
    }
});

socket.on('answer', async (data) => {
    const { sdp, senderId } = data;
    console.log(`[WebRTC] Recebida resposta de ${senderId}`);
    const pc = peerConnections[senderId]; // Deve existir
    if (pc && !pc.currentRemoteDescription) { // Verifica se ainda não foi definida
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (error) {
            console.error(`Erro ao definir resposta remota para ${senderId}:`, error);
        }
    }
});

socket.on('iceCandidate', async (data) => {
    const { candidate, senderId } = data;
    console.log(`[WebRTC] Recebido ICE Candidate de ${senderId}`);
    const pc = peerConnections[senderId]; // Deve existir
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Erro ao adicionar ICE candidate:', e);
        }
    }
});

socket.on('active-rooms-list', (rooms) => {
    updateRoomList(rooms);
});

socket.on('room-joined', (roomName) => {
    currentRoomSpan.textContent = roomName;
    chatMessages.innerHTML = ''; // Limpa mensagens ao mudar de sala
    socket.emit('request-active-rooms'); // Para atualizar a lista de salas
});

socket.on('new-message', (message) => {
    displayMessage(message.username, message.message, message.room, message.type);
});

socket.on('new-audio', (message) => {
    // É importante recriar o Blob a partir do Buffer para reprodução
    // O backend enviava o buffer, o frontend precisa criar o Blob para URL.createObjectURL
    // Se o backend estiver enviando string base64, converta:
    const byteCharacters = atob(message.audio); // Decodifica base64
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const audioBlob = new Blob([byteArray], { type: 'audio/webm' });

    displayMessage(message.username, null, message.room, 'audio', audioBlob);
});

socket.on('previous-messages', (messages) => {
    messages.forEach(msg => {
        if (msg.type === 'audio' && msg.audio) {
            // Se o backend enviou o Buffer diretamente, msg.audio.data será um array de números
            const audioBlob = new Blob([new Uint8Array(msg.audio.data)], { type: 'audio/webm' });
            displayMessage(msg.username, null, msg.room, 'audio', audioBlob);
        } else if (msg.type === 'text' && msg.message) {
            displayMessage(msg.username, msg.message, msg.room, msg.type);
        }
    });
});

socket.on('login-error', (message) => {
    alert('Erro de login: ' + message);
});

socket.on('room-error', (message) => {
    alert('Erro de sala: ' + message);
});

socket.on('room-created', (roomName) => {
    alert(`Sala "${roomName}" criada com sucesso!`);
    socket.emit('join-room', roomName); // Automaticamente entra na sala recém-criada
});


// --- Event Listeners DOM ---

// Autenticação (Registro e Login)
if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = registerForm.username.value;
        const password = registerForm.password.value;
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            alert(data.message);
            if (res.ok) {
                // Registro bem-sucedido, talvez redirecionar para login ou logar automaticamente
                registerForm.reset();
            }
        } catch (error) {
            console.error('Erro de registro:', error);
            alert('Erro ao registrar. Tente novamente.');
        }
    });
}

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = loginForm.username.value;
        const password = loginForm.password.value;
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (res.ok) {
                setUsername(username);
                alert(data.message);
                document.getElementById('login-section').style.display = 'none';
                document.getElementById('chat-section').style.display = 'block';
                document.getElementById('video-section').style.display = 'block';
                
                // Iniciar o stream local e avisar o Socket.IO sobre o usuário logado
                await startLocalStream();
                socket.emit('set-username', username);
                socket.emit('join-room', 'público'); // Entra na sala padrão
            } else {
                alert(data.message);
            }
        } catch (error) {
            console.error('Erro de login:', error);
            alert('Erro ao fazer login. Tente novamente.');
        }
    });
}

// Botões de chat e sala
if (sendButton) {
    sendButton.addEventListener('click', () => {
        const message = messageInput.value;
        const room = currentRoomSpan.textContent;
        if (message.trim() && room) {
            socket.emit('send-message', { text: message, room: room });
            messageInput.value = '';
        }
    });
}

if (messageInput) {
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendButton.click();
        }
    });
}

if (createRoomButton) {
    createRoomButton.addEventListener('click', () => {
        const roomName = newRoomInput.value;
        if (roomName.trim()) {
            socket.emit('create-room', roomName);
            newRoomInput.value = '';
        } else {
            alert('Por favor, digite um nome para a sala.');
        }
    });
}

// Botões de controle de mídia
if (document.getElementById('toggleMic')) {
    document.getElementById('toggleMic').addEventListener('click', () => {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                console.log('Microfone ' + (audioTrack.enabled ? 'ativado' : 'desativado'));
            }
        }
    });
}

if (document.getElementById('toggleCamera')) {
    document.getElementById('toggleCamera').addEventListener('click', () => {
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                console.log('Câmera ' + (videoTrack.enabled ? 'ativada' : 'desativada'));
            }
        }
    });
}

// Gravação de áudio
if (audioRecordButton) {
    audioRecordButton.addEventListener('mousedown', async () => {
        if (!localStream) {
            alert("Por favor, permita o acesso ao microfone primeiro.");
            return;
        }
        // Clona o track de áudio para gravar, para não interromper a chamada em andamento
        const audioTrackForRecording = localStream.getAudioTracks()[0].clone(); 
        if (!audioTrackForRecording) {
            alert("Nenhum track de áudio disponível para gravação.");
            return;
        }

        audioChunks = [];
        mediaRecorder = new MediaRecorder(new MediaStream([audioTrackForRecording]));
        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };
        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64Audio = e.target.result.split(',')[1]; // Pega apenas a parte base64
                const room = currentRoomSpan.textContent;
                socket.emit('send-audio', { audio: base64Audio, room: room });
            };
            reader.readAsDataURL(audioBlob);
            console.log('Áudio gravado e enviado.');
            audioTrackForRecording.stop(); // Para o track clonado de gravação
        };
        mediaRecorder.start();
        audioRecordButton.textContent = 'Gravando... Solte para enviar';
        audioRecordButton.style.backgroundColor = 'red';
    });

    audioRecordButton.addEventListener('mouseup', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            audioRecordButton.textContent = 'Gravar Áudio';
            audioRecordButton.style.backgroundColor = '';
        }
    });
}

// --- Função de Início Principal ---
async function startApplication() {
    const storedUsername = getUsername();
    if (storedUsername) {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('chat-section').style.display = 'block';
        document.getElementById('video-section').style.display = 'block';
        
        // Inicie o stream local e avise o Socket.IO sobre o usuário logado
        await startLocalStream();
        socket.emit('set-username', storedUsername);
        socket.emit('join-room', 'público'); // Entra na sala padrão
        console.log("Aplicação iniciada com usuário logado.");
    } else {
        console.log("Usuário não logado. Exibindo tela de login.");
        document.getElementById('login-section').style.display = 'block';
        document.getElementById('chat-section').style.display = 'none';
        document.getElementById('video-section').style.display = 'none';
    }
}

// Inicia a aplicação quando a página é carregada
document.addEventListener('DOMContentLoaded', startApplication);