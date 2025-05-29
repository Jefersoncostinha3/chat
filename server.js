// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

// Certifique-se de que seus modelos User e Message estão corretos e acessíveis
const User = require('./models/User'); 
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);

// Configuração do Socket.IO com CORS
// ATENÇÃO:
// Para TESTE LOCAL: use "http://localhost:3000" ou "*" (qualquer origem).
// Se o frontend está no mesmo servidor Express e servindo via 'public', use "http://localhost:3000".
// Para PRODUÇÃO (Render): use a URL EXATA do seu frontend no Render (ex: 'https://seunome-frontend.onrender.com').
const io = new Server(server, {
    cors: {
        origin: "https://chat-nyze.onrender.com", // MUITO CUIDADO COM ISTO EM PRODUÇÃO! Use a URL específica do seu frontend.
        methods: ["GET", "POST"]
    }
});

// Conexão com o MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB conectado com sucesso!');
    } catch (error) {
        console.error(`Erro ao conectar ao MongoDB: ${error.message}`);
        // Se a conexão com o DB falhar, o servidor não pode operar corretamente
        process.exit(1); 
    }
};
connectDB();

app.use(express.json()); // Permite que o Express parseie JSON no corpo das requisições
app.use(express.static(path.join(__dirname, 'public'))); // Serve arquivos estáticos do diretório 'public'

// Middleware para logar todas as requisições HTTP (útil para depuração)
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

// --- Rotas de Autenticação (REST API) ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    console.log('Requisição de registro recebida:', { username, password });
    if (!username || !password) {
        console.log('Erro: Usuário e senha são obrigatórios (backend)');
        return res.status(400).json({ message: 'Usuário e senha são obrigatórios.' });
    }
    try {
        const userExists = await User.findOne({ username });
        if (userExists) {
            console.log('Erro: Nome de usuário já existe (backend)');
            return res.status(400).json({ message: 'Nome de usuário já existe. Escolha outro.' });
        }
        const user = await User.create({ username, password });
        console.log('Usuário registrado com sucesso:', user.username);
        res.status(201).json({ message: 'Usuário registrado com sucesso!', username: user.username });
    } catch (error) {
        console.error("ERRO GRAVE NO REGISTRO (BACKEND):", error);
        res.status(500).json({ message: 'Erro no servidor ao registrar usuário.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    console.log('Requisição de login recebida:', { username, password });
    if (!username || !password) {
        console.log('Erro: Usuário e senha são obrigatórios (login backend)');
        return res.status(400).json({ message: 'Usuário e senha são obrigatórios.' });
    }
    try {
        const user = await User.findOne({ username });
        if (user && (await user.matchPassword(password))) {
            console.log('Login bem-sucedido:', user.username);
            res.status(200).json({ message: 'Login bem-sucedido!', username: user.username });
        } else {
            console.log('Credenciais inválidas (login backend)');
            res.status(401).json({ message: 'Credenciais inválidas. Verifique usuário e senha.' });
        }
    } catch (error) {
        console.error("ERRO GRAVE NO LOGIN (BACKEND):", error);
        res.status(500).json({ message: 'Erro no servidor ao fazer login.' });
    }
});

// --- Lógica do Socket.IO (Chat em Tempo Real e WebRTC Signaling) ---

const connectedUsers = {}; // Mapeia socket.id para username
const rooms = { 'público': new Set() }; // 'público' é a sala padrão, sempre existe.

// Função para obter todas as salas que já tiveram mensagens OU que têm usuários conectados
async function getAllKnownRooms() {
    try {
        const roomsFromDB = await Message.distinct('room');
        // Filtra salas que têm usuários conectados
        const currentActiveRooms = Object.keys(rooms).filter(roomName => rooms[roomName].size > 0);
        const combinedRooms = new Set([...roomsFromDB, ...currentActiveRooms]);

        if (!combinedRooms.has('público')) {
            combinedRooms.add('público');
        }

        return Array.from(combinedRooms).sort((a, b) => {
            if (a === 'público') return -1;
            if (b === 'público') return 1;
            return a.localeCompare(b);
        });
    } catch (error) {
        console.error("Erro ao obter todas as salas conhecidas:", error);
        return ['público'];
    }
}

// Função para enviar a lista de salas ativas para todos os usuários
async function emitActiveRooms() {
    const activeRooms = await getAllKnownRooms();
    console.log('Emitindo salas ativas para todos:', activeRooms);
    io.emit('active-rooms-list', activeRooms);
}

io.on('connection', async (socket) => {
    console.log(`Um usuário conectou ao Socket.IO: ${socket.id}`);

    // Garante que a lista de salas é emitida para o novo cliente também
    await emitActiveRooms();

    // Evento para quando o frontend solicita a lista de salas
    socket.on('request-active-rooms', async () => {
        console.log(`[Socket ${socket.id}] Solicitou lista de salas ativas.`);
        await emitActiveRooms(); // Emite para todos, incluindo o solicitante
    });

    socket.on('set-username', async (username) => {
        connectedUsers[socket.id] = username;
        console.log(`Usuário autenticado no Socket.IO: ${username} (ID: ${socket.id})`);

        // Verifica se o usuário já está em alguma sala, e se não, o coloca na sala 'público'
        let isInAnyRoom = false;
        for (const room of socket.rooms) {
            if (room !== socket.id) { // Se o socket já está em uma sala que não é seu próprio ID
                isInAnyRoom = true;
                break;
            }
        }

        if (!isInAnyRoom) {
            socket.join('público');
            if (!rooms['público']) rooms['público'] = new Set();
            rooms['público'].add(socket.id);
            // Só emite user-connected se realmente entrou na sala (e não apenas se reconectou)
            io.to('público').emit('user-connected', username); 
            console.log(`Usuário ${username} entrou na sala: Público`);

            const historicalMessages = await Message.find({ room: 'público' })
                .sort({ timestamp: 1 })
                .limit(50);
            socket.emit('previous-messages', historicalMessages);
            await emitActiveRooms();
            // Notifica outros peers na sala que um novo usuário (socket) entrou
            socket.to('público').emit('userJoined', socket.id); 
        }
    });

    socket.on('disconnect', async () => {
        const username = connectedUsers[socket.id];
        if (username) {
            console.log(`Usuário desconectou do Socket.IO: ${username} (ID: ${socket.id})`);
            
            // Itera pelas salas para remover o socket.id
            for (const roomName in rooms) {
                if (rooms[roomName].has(socket.id)) {
                    rooms[roomName].delete(socket.id);
                    console.log(`Usuário ${username} saiu da sala: ${roomName}`);
                    // Notifica a sala sobre o usuário que saiu (para fins de WebRTC também)
                    io.to(roomName).emit('userLeft', socket.id); 
                }
            }
            delete connectedUsers[socket.id];
            await emitActiveRooms();
        }
    });

    socket.on('send-message', async (data) => {
        const username = connectedUsers[socket.id];
        const roomName = data.room ? data.room.toLowerCase() : 'público';

        if (username) {
            const message = {
                username: username,
                message: data.text,
                room: roomName,
                type: 'text',
                timestamp: new Date()
            };
            console.log(`Mensagem recebida na sala ${message.room}: ${message.username}: ${message.message}`);

            try {
                const newMessage = new Message(message);
                await newMessage.save();
                console.log('Mensagem salva no DB.');
            } catch (error) {
                console.error('Erro ao salvar mensagem no DB:', error);
            }

            io.to(roomName).emit('new-message', message);
        } else {
            socket.emit('login-error', 'Você precisa estar logado para enviar mensagens.');
        }
    });

    socket.on('send-audio', async (data) => {
        const username = connectedUsers[socket.id];
        const roomName = data.room ? data.room.toLowerCase() : 'público';

        if (username) {
            const audioMessage = {
                username: username,
                audio: data.audio,
                room: roomName,
                type: 'audio',
                timestamp: new Date()
            };
            console.log(`Áudio recebido na sala ${audioMessage.room} de ${audioMessage.username}`);

            try {
                // Decode Base64 audio to Buffer before saving
                const audioBuffer = Buffer.from(data.audio, 'base64');
                const newAudioMessage = new Message({
                    username: username,
                    audio: audioBuffer,
                    room: roomName,
                    type: 'audio',
                    timestamp: new Date()
                });
                await newAudioMessage.save();
                console.log('Áudio salvo no DB.');
            } catch (error) {
                console.error('Erro ao salvar áudio no DB:', error);
            }

            io.to(roomName).emit('new-audio', audioMessage);
        } else {
            socket.emit('login-error', 'Você precisa estar logado para enviar áudio.');
        }
    });

    socket.on('create-room', async (roomName) => {
        const username = connectedUsers[socket.id];
        if (!username) {
            socket.emit('room-error', 'Você precisa estar logado para criar uma sala.');
            return;
        }

        const normalizedRoomName = roomName.trim().toLowerCase();
        if (normalizedRoomName === '' || normalizedRoomName === 'público') {
            socket.emit('room-error', 'Nome de sala inválido ou reservado.');
            return;
        }

        // Verifica a existência da sala tanto no DB quanto nas salas ativas em memória
        const roomExistsInDB = await Message.findOne({ room: normalizedRoomName });
        const roomExistsInMemory = rooms[normalizedRoomName] !== undefined;

        if (roomExistsInDB || roomExistsInMemory) {
            socket.emit('room-error', `A sala "${roomName}" já existe. Escolha outro nome.`);
            return;
        }

        // Cria a sala em memória
        rooms[normalizedRoomName] = new Set();
        console.log(`Sala criada (em memória): ${normalizedRoomName} por ${username}`);
        socket.emit('room-created', roomName); // Avisa o criador da sala
        await emitActiveRooms(); // Atualiza a lista de salas para todos
    });

    socket.on('join-room', async (roomName) => {
        const username = connectedUsers[socket.id];
        if (!username) {
            socket.emit('room-error', 'Você precisa estar logado para entrar em uma sala.');
            return;
        }

        const normalizedRoomName = roomName.trim().toLowerCase();
        if (normalizedRoomName === '') {
            socket.emit('room-error', 'O nome da sala não pode ser vazio.');
            return;
        }

        const roomExistsInDB = await Message.findOne({ room: normalizedRoomName });
        const roomExistsInOurMemoryMap = rooms[normalizedRoomName] !== undefined;

        if (!roomExistsInDB && !roomExistsInOurMemoryMap && normalizedRoomName !== 'público') {
            socket.emit('room-error', `A sala "${roomName}" não foi encontrada ou não tem histórico/usuários. Verifique o nome.`);
            return;
        }

        // Remove o socket de todas as salas atuais, exceto seu próprio ID
        for (const room of socket.rooms) {
            if (room !== socket.id) {
                socket.leave(room);
                const currentRoomSet = rooms[room];
                if (currentRoomSet) {
                    currentRoomSet.delete(socket.id);
                    // Avisa a sala de onde o usuário saiu (para WebRTC também)
                    io.to(room).emit('userLeft', socket.id); 
                }
            }
        }

        // Adiciona o socket à nova sala
        socket.join(normalizedRoomName);
        if (!rooms[normalizedRoomName]) {
            rooms[normalizedRoomName] = new Set();
        }
        rooms[normalizedRoomName].add(socket.id);

        console.log(`Usuário ${username} entrou na sala: ${normalizedRoomName}`);
        socket.emit('room-joined', roomName); // Avisa o usuário que ele entrou na sala
        io.to(normalizedRoomName).emit('user-connected', username); // Avisa outros usuários da sala que um usuário entrou

        // Envia histórico de mensagens da nova sala
        const historicalMessages = await Message.find({ room: normalizedRoomName })
            .sort({ timestamp: 1 })
            .limit(50);
        socket.emit('previous-messages', historicalMessages);

        // Notifica os usuários da sala sobre a entrada de um novo socket (para fins de WebRTC)
        // Isso é crucial para as chamadas WebRTC
        socket.to(normalizedRoomName).emit('userJoined', socket.id); // Notifica outros sockets na sala
        
        // Envia a lista de peers existentes na sala para o recém-chegado
        const peersInNewRoom = Array.from(rooms[normalizedRoomName]).filter(id => id !== socket.id);
        peersInNewRoom.forEach(peerId => {
            socket.emit('userJoined', peerId); // Avisa o novo usuário sobre os peers existentes
        });

        await emitActiveRooms(); // Atualiza a lista de salas para todos
    });

    // --- WebRTC Signaling Messages ---
    // Oferta de conexão (enviada pelo chamador)
    socket.on('offer', (data) => {
        console.log(`[WebRTC] Recebida oferta de ${socket.id} para ${data.targetSocketId}`);
        // Repassa a oferta para o destino
        socket.to(data.targetSocketId).emit('offer', {
            sdp: data.sdp,
            senderId: socket.id
        });
    });

    // Resposta da oferta (enviada pelo receptor)
    socket.on('answer', (data) => {
        console.log(`[WebRTC] Recebida resposta de ${socket.id} para ${data.targetSocketId}`);
        // Repassa a resposta para o destino
        socket.to(data.targetSocketId).emit('answer', {
            sdp: data.sdp,
            senderId: socket.id
        });
    });

    // ICE Candidate (informações de conectividade de rede)
    socket.on('iceCandidate', (data) => {
        console.log(`[WebRTC] Recebido ICE Candidate de ${socket.id} para ${data.targetSocketId}`);
        // Repassa o ICE Candidate para o destino
        socket.to(data.targetSocketId).emit('iceCandidate', {
            candidate: data.candidate,
            senderId: socket.id
        });
    });

    // Novos eventos para tratamento de chamadas WebRTC
    socket.on('hangup-call', (data) => {
        console.log(`[WebRTC] ${socket.id} desligou a chamada com ${data.targetSocketId}`);
        // Notifica o outro lado que a chamada foi desligada
        socket.to(data.targetSocketId).emit('hangup-call', { senderId: socket.id });
    });

    socket.on('call-rejected', (data) => {
        console.log(`[WebRTC] ${socket.id} rejeitou a chamada de ${data.targetSocketId}`);
        // Notifica o chamador que a chamada foi rejeitada
        socket.to(data.targetSocketId).emit('call-rejected', { senderId: socket.id, reason: data.reason });
    });

    socket.on('call-busy', (data) => {
        console.log(`[WebRTC] ${socket.id} está ocupado para chamada de ${data.targetSocketId}`);
        // Notifica o chamador que o receptor está ocupado
        socket.to(data.targetSocketId).emit('call-busy', { senderId: socket.id });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Socket.IO acessível em http://localhost:${PORT}/socket.io/`);
});
