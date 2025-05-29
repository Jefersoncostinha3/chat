// models/Message.js
const mongoose = require('mongoose');

const messageSchema = mongoose.Schema({
    username: {
        type: String,
        required: true
    },
    message: { // Campo para mensagens de texto
        type: String,
        required: false // Não obrigatório se for áudio
    },
    audio: { // Campo para dados de áudio (Buffer)
        type: Buffer,
        required: false // Não obrigatório se for texto
    },
    room: {
        type: String,
        required: true
    },
    type: { // 'text' ou 'audio'
        type: String,
        required: true,
        enum: ['text', 'audio']
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;