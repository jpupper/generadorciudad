const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Configuración
const hostname = '0.0.0.0';
const port =  3344;

// Estado del mundo
// players: socketId -> { name, color, position: {x,y,z}, rotation: {y} }
const players = new Map();
// objects: [{ id, shape, position: {x,y,z}, rotation: {x,y,z}, size, color }]
const objects = [];
let nextObjectId = 1;

// Utilidades
function hashColorFromId(id) {
  // Genera un color HSL estable a partir del socket.id
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function snapToGrid(p, grid = 1) {
  return {
    x: Math.round(p.x / grid) * grid,
    y: Math.round(p.y / grid) * grid,
    z: Math.round(p.z / grid) * grid,
  };
}

// Servidor HTTP y estáticos
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint simple para salud
app.get('/health', (req, res) => {
  res.json({ ok: true, players: players.size, objects: objects.length });
});

const server = http.createServer(app);
const SOCKET_PATH = '/socket.io';
const io = new Server(server, {
  path: SOCKET_PATH,
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Instrumentación exhaustiva en servidor
console.log('[Server][SocketIO] path configurado:', SOCKET_PATH);
// Traza de upgrades HTTP (WebSocket)
server.on('upgrade', (req, socket, head) => {
  console.log('[Server][HTTP] upgrade', req.url);
});

// Traza Engine.IO por conexión
if (io && io.engine && io.engine.on) {
  io.engine.on('connection', (rawSocket) => {
    try {
      const tname = rawSocket && rawSocket.transport && rawSocket.transport.name;
      console.log('[Server][Engine] connection', { id: rawSocket.id, transport: tname });
      rawSocket.on('upgrade', () => {
        const newT = rawSocket && rawSocket.transport && rawSocket.transport.name;
        console.log('[Server][Engine] upgraded', { id: rawSocket.id, transport: newT });
      });
      rawSocket.on('close', (reason) => {
        console.log('[Server][Engine] close', { id: rawSocket.id, reason });
      });
      rawSocket.on('error', (err) => {
        console.error('[Server][Engine] error', { id: rawSocket.id, err: err && (err.message || err) });
      });
    } catch (e) {
      console.error('[Server][Engine] hook failed', e);
    }
  });
}

// Trazar io.emit global
const _ioEmit = io.emit.bind(io);
io.emit = (event, ...args) => {
  const brief = (() => { try { return JSON.stringify(args[0]).slice(0, 200); } catch { return String(args[0]); } })();
  console.log('[Server][SocketIO] io.emit =>', event, brief);
  return _ioEmit(event, ...args);
};

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id, 'pid:', process.pid);
  console.log('[Server][SocketIO] handshake', {
    id: socket.id,
    ip: socket.handshake && socket.handshake.address,
    headers: {
      host: socket.handshake && socket.handshake.headers && socket.handshake.headers.host,
      origin: socket.handshake && socket.handshake.headers && socket.handshake.headers.origin,
      'x-forwarded-for': socket.handshake && socket.handshake.headers && socket.handshake.headers['x-forwarded-for']
    },
    nsp: socket.nsp && socket.nsp.name,
    query: socket.handshake && socket.handshake.query
  });

  // Entrantes
  socket.onAny((event, ...args) => {
    const brief = (() => { try { return JSON.stringify(args[0]).slice(0, 200); } catch { return String(args[0]); } })();
    console.log('[Server][SocketIO] <=', event, 'from', socket.id, brief);
  });

  // Salientes por broadcast
  const _broadcastEmit = socket.broadcast.emit.bind(socket.broadcast);
  socket.broadcast.emit = (event, ...args) => {
    const brief = (() => { try { return JSON.stringify(args[0]).slice(0, 200); } catch { return String(args[0]); } })();
    console.log('[Server][SocketIO] broadcast =>', event, 'from', socket.id, brief);
    return _broadcastEmit(event, ...args);
  };

  // Registro inicial con nombre (con ACK opcional)
  socket.on('register', (data, ack) => {
    const name = (data && typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : 'Anónimo';
    const color = hashColorFromId(socket.id);
    const player = {
      name,
      color,
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { y: 0 },
    };
    players.set(socket.id, player);

    // Enviar estado inicial al nuevo cliente
    const playersArray = Array.from(players.entries()).map(([id, p]) => ({ id, ...p }));
    socket.emit('init_state', { players: playersArray, objects });

    // ACK al cliente si lo pidió
    if (typeof ack === 'function') {
      try { ack({ ok: true, name, playerCount: players.size }); } catch (e) {}
    }

    // Anunciar a los demás que este jugador se unió
    socket.broadcast.emit('player_joined', { id: socket.id, ...player });
    console.log(`Jugador registrado: ${name} (${socket.id}) pid:${process.pid}`);
  });

  // Actualización de posición/rotación del jugador
  socket.on('player_move', (data) => {
    const p = players.get(socket.id);
    if (!p) return;

    if (data && data.position) {
      const { x, y, z } = data.position;
      // Limitar Y al suelo mínimo
      p.position = { x: Number(x) || 0, y: Math.max(0.5, Number(y) || 0.5), z: Number(z) || 0 };
    }
    if (data && data.rotation) {
      const { y } = data.rotation;
      p.rotation = { y: Number(y) || 0 };
    }

    // Reenviar a otros
    socket.broadcast.emit('player_moved', { id: socket.id, position: p.position, rotation: p.rotation });
  });

  // Colocar objetos
  socket.on('place_object', (data) => {
    const shape = (data && data.shape) || 'cube';
    const size = (data && Number(data.size)) || 1;
    const color = (data && data.color) || '#cccccc';
    let position = (data && data.position) || { x: 0, y: 0.5, z: 0 };
    let rotation = (data && data.rotation) || { x: 0, y: 0, z: 0 };

    // Snap a la grilla
    position = snapToGrid(position, 1);

    // Altura centrada para unidades de 1
    position.y = Math.max(0.5, position.y);

    const object = {
      id: nextObjectId++,
      shape,
      position,
      rotation,
      size,
      color,
    };
    objects.push(object);

    // Difundir a todos (incluyendo al emisor)
    io.emit('object_placed', object);
    console.log('Objeto colocado:', object, 'pid:', process.pid);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id, 'pid:', process.pid);
    if (players.has(socket.id)) {
      players.delete(socket.id);
      socket.broadcast.emit('player_disconnected', { id: socket.id });
    }
  });
});

// Heartbeat de estado para diagnóstico
setInterval(() => {
  console.log('[Server][Heartbeat]', { players: players.size, objects: objects.length, pid: process.pid });
}, 10000);

server.listen(port, hostname, () => {
  console.log(`Server running at http://localhost:${port}/`);
  console.log(`Server running at http://${hostname}:${port}/`);
  console.log(`Static files: ${path.join(__dirname, 'public')}`);
});