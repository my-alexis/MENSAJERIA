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
const enviandoStatus = new Map(); // Para controlar que un asesor no duplique envíos
const upload = multer({ dest: 'uploads/' });

// --- CONFIGURACIÓN DE SEGURIDAD ---
const USUARIO_ADMIN = "admin";
const CLAVE_ADMIN = "Horizons2026"; 

app.use(express.static('public'));
app.use(express.json());

// Middleware de Autenticación
const authMiddleware = (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login === USUARIO_ADMIN && password === CLAVE_ADMIN) {
        return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Acceso New Horizons"');
    res.status(401).send('No autorizado');
};

// Rutas protegidas
app.get('/', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- LÓGICA DE WHATSAPP ---

async function crearSesion(idAsesor, socket = null) {
    const sesionesDir = path.join(__dirname, 'sesiones');
    if (!fs.existsSync(sesionesDir)) fs.mkdirSync(sesionesDir);

    const { state, saveCreds } = await useMultiFileAuthState(`./sesiones/asesor_${idAsesor}`);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['New Horizons', 'Chrome', '1.0.0']
    });

    sessions.set(idAsesor, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr && socket) {
            socket.emit('qr', { idAsesor, qr });
        }
        
        if (connection === 'open') {
            if (socket) socket.emit('ready', { idAsesor });
            console.log(`✅ [SESIÓN] Asesor ${idAsesor} conectado correctamente.`);
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`🔄 [SISTEMA] Reconectando asesor ${idAsesor}...`);
                crearSesion(idAsesor, socket);
            } else {
                console.log(`🛑 [SISTEMA] Sesión de ${idAsesor} cerrada permanentemente.`);
                sessions.delete(idAsesor);
            }
        }
    });
}

// Restaurar sesiones al iniciar
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
        console.log(`🚀 [SOCKET] Solicitud de inicio para: ${data.idAsesor}`);
        crearSesion(data.idAsesor, socket);
    });
});

app.post('/enviar-masivo', authMiddleware, upload.single('archivo'), async (req, res) => {
    const { idAsesor, numeros, mensaje } = req.body;
    const sock = sessions.get(idAsesor);
    
    if (!sock) return res.status(400).json({ success: false, error: "La sesión no está activa." });
    if (enviandoStatus.get(idAsesor)) return res.status(400).json({ success: false, error: "Ya hay un envío en curso para este asesor." });

    let numsArray;
    try {
        numsArray = JSON.parse(numeros);
    } catch (e) {
        return res.status(400).json({ success: false, error: "Formato de lista de números incorrecto." });
    }

    // Responder de inmediato para que la web no cargue infinitamente
    res.json({ success: true, total: numsArray.length });

    // Ejecutar envío en segundo plano
    enviandoStatus.set(idAsesor, true);
    console.log(`📦 [ENVÍO] Iniciando campaña para ${idAsesor} (${numsArray.length} contactos)`);

    for (const num of numsArray) {
        try {
            const jid = `${num.trim()}@s.whatsapp.net`;
            const opciones = {};

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

            console.log(`   📧 Mensaje enviado a ${num}`);
            // Delay humano aleatorio para evitar baneos
            await delay(Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000); 
        } catch (e) {
            console.error(`   ❌ Error con el número ${num}:`, e.message);
        }
    }

    console.log(`✨ [ENVÍO] Campaña de ${idAsesor} finalizada.`);
    enviandoStatus.set(idAsesor, false);

    // Limpieza de archivos
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
});

// Iniciar
server.listen(3000, '0.0.0.0', () => {
    console.log('-------------------------------------------');
    console.log('🚀 NEW HORIZONS - WHATSAPP SERVER');
    console.log('📍 Puerto: 3000');
    console.log('🔑 Usuario:', USUARIO_ADMIN);
    console.log('-------------------------------------------');
    restaurarSesiones();
});