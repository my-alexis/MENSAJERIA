const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const sessions = new Map();
const enviandoStatus = new Map(); 
const upload = multer({ dest: 'uploads/' });

// --- CONFIGURACIÓN ---
app.use(express.static('public'));
app.use(express.json());

// Acceso directo sin contraseña por ahora
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- LÓGICA DE WHATSAPP ---

async function crearSesion(idAsesor, socket = null) {
    const sesionesDir = path.join(__dirname, 'sesiones');
    if (!fs.existsSync(sesionesDir)) fs.mkdirSync(sesionesDir);

    const { state, saveCreds } = await useMultiFileAuthState(`./sesiones/asesor_${idAsesor}`);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }), // Logs limpios sin buffers
        printQRInTerminal: false,
        browser: ['New Horizons', 'Chrome', '1.0.0']
    });

    sessions.set(idAsesor, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && socket) socket.emit('qr', { idAsesor, qr });
        
        if (connection === 'open') {
            if (socket) socket.emit('ready', { idAsesor });
            console.log(`✅ [SESIÓN] Asesor ${idAsesor} conectado.`);
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                crearSesion(idAsesor, socket);
            } else {
                console.log(`🛑 [SISTEMA] Sesión de ${idAsesor} cerrada.`);
                sessions.delete(idAsesor);
            }
        }
    });
}

const restaurarSesiones = () => {
    const dir = './sesiones';
    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(folder => {
            if (folder.startsWith('asesor_')) {
                const id = folder.replace('asesor_', '');
                crearSesion(id);
            }
        });
    }
};

io.on('connection', (socket) => {
    socket.on('iniciar-instancia', (data) => {
        crearSesion(data.idAsesor, socket);
    });
});

app.post('/enviar-masivo', upload.single('archivo'), async (req, res) => {
    const { idAsesor, numeros, mensaje } = req.body;
    const sock = sessions.get(idAsesor);
    
    if (!sock) return res.status(400).json({ success: false, error: "Sesión no activa." });
    if (enviandoStatus.get(idAsesor)) return res.status(400).json({ success: false, error: "Envío en curso." });

    let numsArray;
    try {
        numsArray = JSON.parse(numeros);
    } catch (e) {
        return res.status(400).json({ success: false, error: "Formato incorrecto." });
    }

    res.json({ success: true, total: numsArray.length });

    enviandoStatus.set(idAsesor, true);
    console.log(`📦 [CAMPANIA] Iniciada: ${numsArray.length} contactos.`);

    let enviados = 0;
    let fallidos = 0;
    let contadorLote = 0;

    for (const num of numsArray) {
        // --- REGLA DE NEGOCIO: PAUSA DE 10 MIN CADA 40 ENVÍOS ---
        if (contadorLote === 40) {
            console.log(`⏳ [PAUSA] Lote de 40 completado. Esperando 10 minutos...`);
            await delay(10 * 60 * 1000); // 10 minutos
            contadorLote = 0;
        }

        try {
            const jid = `${num.trim()}@s.whatsapp.net`;
            if (req.file) {
                const contenido = fs.readFileSync(req.file.path);
                const isImage = req.file.mimetype.startsWith('image/');
                if (isImage) {
                    await sock.sendMessage(jid, { image: contenido, caption: mensaje });
                } else {
                    await sock.sendMessage(jid, { document: contenido, fileName: req.file.originalname, caption: mensaje });
                }
            } else {
                await sock.sendMessage(jid, { text: mensaje });
            }

            enviados++;
            contadorLote++;
            console.log(`   📧 [${enviados}/${numsArray.length}] Enviado a ${num}`);
            
            // Delay aleatorio entre mensajes (8-12 seg)
            await delay(Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000); 
        } catch (e) {
            fallidos++;
            console.error(`   ❌ Error con ${num}:`, e.message);
        }
    }

    // --- REPORTE DE PROCESOS ---
    console.log('-------------------------------------------');
    console.log(`✨ [REPORTE FINAL]`);
    console.log(`✅ Exitosos: ${enviados}`);
    console.log(`❌ Fallidos: ${fallidos}`);
    console.log('-------------------------------------------');
    
    enviandoStatus.set(idAsesor, false);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
});

server.listen(3000, '0.0.0.0', () => {
    console.log('-------------------------------------------');
    console.log('🚀 NEW HORIZONS - SERVER READY');
    console.log('📍 Puerto: 3000 | Seguridad: OFF');
    console.log('-------------------------------------------');
    restaurarSesiones();
});