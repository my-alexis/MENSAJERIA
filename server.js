const helmet = require('helmet');

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

// --- CONFIGURACIÓN DE MATRIX ---
const API_KEY = 'c602f00b4dafe00e89fabb34a53862d49d4ae0947fe8323b96c7';
const DOMINIO = 'https://newhorizonsperu.matrixlms.com';

const clients = new Map();

app.use(express.static('public'));
app.use(express.json());

// --- UTILIDADES ---

/**
 * Convierte una fecha ISO (2026-06-04) en texto (4 de junio de 2026)
 */
const formatearFechaTexto = (fechaISO) => {
    if (!fechaISO || fechaISO === "No definida") return "No definida";
    try {
        const fecha = new Date(fechaISO);
        // Usamos UTC para evitar que el desfase horario cambie el día
        return new Intl.DateTimeFormat('es-PE', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC'
        }).format(fecha);
    } catch (e) {
        return fechaISO;
    }
};

// --- LÓGICA DE WHATSAPP ---
async function inicializarCliente(idAsesor, socket) {
    console.log(`🚀 [SISTEMA] Iniciando WhatsApp para: ${idAsesor}`);
    
    // Si ya existe una instancia para este asesor, la cerramos antes de crear una nueva
    if (clients.has(idAsesor)) {
        try {
            await clients.get(idAsesor).destroy();
        } catch (e) {
            console.error("Error destruyendo cliente previo:", e.message);
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `asesor_${idAsesor}`,
            dataPath: './sesiones'
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
        }
    });

    client.on('qr', (qr) => {
        console.log(`📲 [${idAsesor}] Nuevo QR generado`);
        socket.emit('qr', { idAsesor, qr });
    });

    client.on('ready', () => {
        console.log(`✅ [${idAsesor}] Cliente listo y conectado`);
        socket.emit('ready', { idAsesor });
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ [${idAsesor}] Desconectado:`, reason);
        clients.delete(idAsesor);
        socket.emit('disconnected', { idAsesor, reason });
    });

    client.initialize();
    clients.set(idAsesor, client);
}

io.on('connection', (socket) => {
    socket.on('iniciar-instancia', (data) => {
        if (data.idAsesor) {
            inicializarCliente(data.idAsesor, socket);
        }
    });
});

// --- RUTA: BÚSQUEDA DE ALUMNOS E INFO DE CURSO ---
app.post('/buscar-alumnos', async (req, res) => {
    const { cursoId } = req.body;
    if (!cursoId) return res.status(400).json({ success: false, error: "ID de clase requerido" });

    try {
        // 1. Obtener detalles del curso (Nombre y Fecha)
        const resCurso = await axios.get(`${DOMINIO}/api/v3/courses/${cursoId}?api_key=${API_KEY}`);
        
        const infoCurso = {
            nombre: resCurso.data.name,
            fechaInicio: formatearFechaTexto(resCurso.data.start_at)
        };

        // 2. Obtener lista de alumnos con manejo de paginación
        let todosLosAlumnos = [];
        let offset = 0;
        const limit = 100;
        let hayMasPaginas = true;

        while (hayMasPaginas) {
            const resAlu = await axios.get(
                `${DOMINIO}/api/v3/courses/${cursoId}/learners?api_key=${API_KEY}&$include=user&$limit=${limit}&$offset=${offset}`
            );

            if (resAlu.data && resAlu.data.length > 0) {
                // Consultar teléfonos individualmente
                const promesasDetalle = resAlu.data.map(item => 
                    axios.get(`${DOMINIO}/api/v3/users/${item.user_id}?api_key=${API_KEY}`)
                );
                
                const detalles = await Promise.all(promesasDetalle);
                
                const listaMapeada = detalles.map(d => {
                    const u = d.data;
                    let telLimpio = u.phone ? u.phone.replace(/\s+/g, '').replace(/\D/g, '') : "";
                    
                    // Corrección de prefijos internacionales comunes
                    if (telLimpio.startsWith('00')) telLimpio = telLimpio.substring(2);

                    return {
                        nombre: `${u.first_name} ${u.last_name}`.toUpperCase(),
                        telefono: telLimpio
                    };
                });

                todosLosAlumnos = todosLosAlumnos.concat(listaMapeada);
                resAlu.data.length < limit ? hayMasPaginas = false : offset += limit;
            } else {
                hayMasPaginas = false;
            }
        }

        res.json({ 
            success: true, 
            curso: infoCurso, 
            alumnos: todosLosAlumnos 
        });

    } catch (e) {
        console.error("Error en MatrixLMS:", e.message);
        res.status(500).json({ success: false, error: "Error al consultar MatrixLMS" });
    }
});

// --- RUTA: ENVÍO MASIVO ---
app.post('/enviar-masivo', upload.single('archivo'), async (req, res) => {
    const { idAsesor, numeros, mensaje } = req.body;
    
    const client = clients.get(idAsesor);
    if (!client) {
        return res.status(400).json({ success: false, error: "La sesión de WhatsApp no está activa para este asesor." });
    }

    let numsArray = [];
    try {
        numsArray = JSON.parse(numeros);
    } catch (e) {
        return res.status(400).json({ success: false, error: "Formato de números inválido." });
    }

    // Responder al cliente para liberar el frontend
    res.json({ success: true, total: numsArray.length });

    // Envío en segundo plano
    for (const num of numsArray) {
        try {
            const cleanNum = num.trim();
            if (!cleanNum) continue;

            // Formato de destino de WhatsApp Web.js
            const chatId = cleanNum.includes('@c.us') ? cleanNum : `${cleanNum}@c.us`;
            await client.sendMessage(chatId, mensaje);
            
            // Pausa de seguridad aleatoria entre 6 y 8 segundos para simular comportamiento humano
            const pausa = Math.floor(Math.random() * (8000 - 6000 + 1)) + 6000;
            await new Promise(resolve => setTimeout(resolve, pausa));
        } catch (e) {
            console.error(`❌ Error enviando a ${num}:`, e.message);
        }
    }

    // Notificar fin del lote
    io.emit('envio-finalizado', { idAsesor, total: numsArray.length });
});

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    =================================================
    🚀 SERVIDOR DE MENSAJERÍA MASIVA NH
    -------------------------------------------------
    Puerto: ${PORT}
    Estado: Corriendo
    =================================================
    `);
});
app.use(helmet());