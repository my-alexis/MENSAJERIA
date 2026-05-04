const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

// Guardaremos las instancias aquí
const clients = new Map();

app.use(express.static('public'));
app.use(express.json());

async function inicializarCliente(idAsesor, socket) {
    console.log(`🚀 [SISTEMA] Iniciando WhatsApp para: ${idAsesor}`);

    // Si ya existe una instancia previa, la cerramos
    if (clients.has(idAsesor)) {
        try { await clients.get(idAsesor).destroy(); } catch (e) {}
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `asesor_${idAsesor}`,
            dataPath: './sesiones'
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`📲 [QR] Generado para ${idAsesor}`);
        socket.emit('qr', { idAsesor, qr });
    });

    client.on('ready', () => {
        console.log(`✅ [SESIÓN] ${idAsesor} está listo`);
        socket.emit('ready', { idAsesor });
    });

    client.on('disconnected', (reason) => {
        console.log(`🛑 [DESCONECTADO] ${idAsesor}: ${reason}`);
        clients.delete(idAsesor);
    });

    client.initialize();
    clients.set(idAsesor, client);
}

io.on('connection', (socket) => {
    socket.on('iniciar-instancia', (data) => {
        inicializarCliente(data.idAsesor, socket);
    });
});


app.post('/enviar-masivo', upload.single('archivo'), async (req, res) => {
    const { idAsesor, numeros, mensaje } = req.body;
    const client = clients.get(idAsesor);

    if (!client) return res.status(400).json({ success: false, error: "Sesión no activa." });

    let numsArray = JSON.parse(numeros);
    res.json({ success: true, total: numsArray.length });

    // --- PROCESO EN SEGUNDO PLANO ---
    for (const num of numsArray) {
        try {
            const chatId = `${num.trim()}@c.us`;
            await client.sendMessage(chatId, mensaje);
            
            // Delay de seguridad (7 segundos)
            await new Promise(resolve => setTimeout(resolve, 7000));
        } catch (e) {
            console.error(`Error enviando a ${num}:`, e);
        }
    }

    // Al terminar el bucle, enviamos la señal al frontend
    io.emit('envio-finalizado', { idAsesor, total: numsArray.length });
});


server.listen(3000, '0.0.0.0', () => {
    console.log('🚀 SERVIDOR WHATSAPP-WEB.JS CORRIENDO EN PUERTO 3000');
});