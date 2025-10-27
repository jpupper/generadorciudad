(() => {
  const cfg = window.appConfig;

  // Socket
  const socket = io(window.location.origin, { path: cfg.socketPath });

  // Instrumentación exhaustiva de Socket.IO en cliente
  (function installSocketDebug(sock) {
    try {
      const mgr = sock.io;
      console.log('[Client][Socket] init', {
        origin: window.location.origin,
        path: cfg.socketPath,
        transports: (mgr && mgr.opts && mgr.opts.transports) || undefined
      });

      // Entrantes
      sock.onAny((event, ...args) => {
        const brief = (() => {
          try { return JSON.stringify(args[0]).slice(0, 200); } catch { return String(args[0]); }
        })();
        console.log('[Client][Socket] <=', event, brief);
      });

      // Salientes
      const _emit = sock.emit.bind(sock);
      sock.emit = (event, ...args) => {
        const brief = (() => {
          try { return JSON.stringify(args[0]).slice(0, 200); } catch { return String(args[0]); }
        })();
        console.log('[Client][Socket] =>', event, brief);
        return _emit(event, ...args);
      };

      // Conexión / reconexión
      sock.on('connect', () => {
        const transport = mgr && mgr.engine && mgr.engine.transport && mgr.engine.transport.name;
        console.log('[Client][Socket] connect id:', sock.id, 'transport:', transport);
      });
      sock.on('connect_error', (err) => console.error('[Client][Socket] connect_error', err && (err.message || err)));
      sock.on('error', (err) => console.error('[Client][Socket] error', err));
      sock.on('disconnect', (reason) => console.warn('[Client][Socket] disconnect', reason));
      if (mgr && mgr.on) {
        mgr.on('reconnect_attempt', (attempt) => console.log('[Client][Socket] reconnect_attempt', attempt));
        mgr.on('reconnect', (attempt) => console.log('[Client][Socket] reconnect', attempt));
        mgr.on('reconnect_error', (err) => console.error('[Client][Socket] reconnect_error', err));
        mgr.on('reconnect_failed', () => console.error('[Client][Socket] reconnect_failed'));
        mgr.on('ping', () => console.log('[Client][Socket] ping'));
        mgr.on('pong', (latency) => console.log('[Client][Socket] pong', latency));
      }
      if (mgr && mgr.engine && mgr.engine.on) {
        mgr.engine.on('upgrade', (tr) => console.log('[Client][Engine] upgrade to', tr && tr.name));
        mgr.engine.on('close', (reason) => console.log('[Client][Engine] close', reason));
        mgr.engine.on('error', (err) => console.error('[Client][Engine] error', err));
      }
    } catch (e) {
      console.error('[Client][Socket] debug install failed', e);
    }
  })(socket);
  let myId = null;
  let myName = '';

  // Three.js
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 8, 14);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.5, 0);

  // Luces
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = true;
  scene.add(dirLight);

  // Suelo y grilla
  const groundSize = cfg.world.groundSize;
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, side: THREE.DoubleSide });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.isGround = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(groundSize, groundSize, 0x3a3f4a, 0x2b303a);
  grid.position.y = 0.001;
  scene.add(grid);

  // Raycaster
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // Estado del cliente
  const players = new Map(); // id -> { group, mesh, label, color, name }
  const objectMeshes = new Map(); // objectId -> mesh
  let localPlayer = null;
  let currentShape = cfg.default.shape;
  let currentColor = cfg.default.color;

  // UI
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const nameInput = document.getElementById('playerName');
  const toolbar = document.getElementById('toolbar');
  const colorPicker = document.getElementById('colorPicker');
  const shapeButtons = Array.from(document.querySelectorAll('.shape-btn'));

  shapeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      shapeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentShape = btn.dataset.shape;
    });
  });

  colorPicker.addEventListener('input', () => {
    currentColor = colorPicker.value;
  });

  // Teclado para mover
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Digit1') setShape('cube');
    if (e.code === 'Digit2') setShape('sphere');
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  function setShape(shape) {
    currentShape = shape;
    shapeButtons.forEach(b => {
      b.classList.toggle('active', b.dataset.shape === shape);
    });
  }

  // Sockets
  socket.on('connect', () => {
    myId = socket.id;
    console.log('Conectado con id:', myId);
  });

  socket.on('init_state', ({ players: playersArray, objects }) => {
    console.log('[Socket] init_state recibido', { players: playersArray.length, objects: objects.length });
    // Cargar jugadores existentes
    playersArray.forEach(p => addOrUpdatePlayer(p.id, p));

    // Determinar local
    const me = players.get(myId);
    if (me) {
      localPlayer = me;
      controls.target.copy(localPlayer.mesh.position);
    }

    // Cargar objetos
    objects.forEach(obj => addObjectMesh(obj));

    // Ocultar overlay
    overlay.classList.add('hidden');
    toolbar.style.display = 'flex';
  });

  socket.on('player_joined', (p) => {
    addOrUpdatePlayer(p.id, p);
  });

  socket.on('player_moved', (p) => {
    const entry = players.get(p.id);
    if (!entry) return;
    entry.mesh.position.set(p.position.x, p.position.y, p.position.z);
    entry.group.position.copy(entry.mesh.position);
    entry.label.position.set(entry.mesh.position.x, entry.mesh.position.y + 1.2, entry.mesh.position.z);
  });

  socket.on('player_disconnected', ({ id }) => {
    const entry = players.get(id);
    if (!entry) return;
    scene.remove(entry.group);
    players.delete(id);
  });

  socket.on('object_placed', (obj) => {
    addObjectMesh(obj);
  });

  // Registro por UI
  console.log('[UI] Binding click handler for startBtn');
  startBtn.addEventListener('click', () => {
    const name = (nameInput.value || '').trim() || 'Anónimo';
    myName = name;
    console.log('BOTON ENTRAR CLICKEADO');
    console.log('[UI] Entrar clicado, registrando con nombre:', name);
    // Forzar ocultar overlay inmediatamente
    overlay.classList.add('hidden');
    console.log('[UI] Overlay ocultado inmediato por clic');
    toolbar.style.display = 'flex';
    // Crear jugador local provisional inmediatamente
    ensureLocalPlayer();
    // Permitir múltiples clicks para diagnóstico
    // startBtn.disabled = true;
    socket.emit('register', { name }, (res) => {
      console.log('[Socket] register_ack', res);
      // Ocultar overlay también al recibir ACK
      overlay.classList.add('hidden');
      console.log('[UI] Overlay ocultado por ACK');
      toolbar.style.display = 'flex';
      ensureLocalPlayer();
    });
  });

  // Permitir enviar con Enter en el input
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startBtn.click();
    }
  });

  // Raycast para colocar objetos
  window.addEventListener('mousedown', (event) => {
    if (!localPlayer) {
      console.warn('[UI] Click ignorado: localPlayer aún no está listo');
      return;
    }
    if (event.button !== 0) return; // Solo botón izquierdo

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const intersectables = [ground, ...Array.from(objectMeshes.values())];
    const intersects = raycaster.intersectObjects(intersectables, true);
    if (!intersects.length) return;
    const hit = intersects[0];

    let target = new THREE.Vector3();
    if (hit.object.userData.isGround) {
      target.copy(hit.point);
      target.y = 0.5; // altura del bloque centrado en suelo
    } else {
      const basePos = hit.object.position.clone();
      const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      target.copy(basePos.add(n)); // apilar en dirección de la cara
    }

    target.x = Math.round(target.x / cfg.gridSize) * cfg.gridSize;
    target.y = Math.max(0.5, Math.round(target.y / cfg.gridSize) * cfg.gridSize);
    target.z = Math.round(target.z / cfg.gridSize) * cfg.gridSize;

    socket.emit('place_object', {
      shape: currentShape,
      position: { x: target.x, y: target.y, z: target.z },
      size: cfg.default.size,
      color: currentColor,
      rotation: { x: 0, y: 0, z: 0 },
    });
  });

  // Añadir/actualizar players
  function addOrUpdatePlayer(id, p) {
    let entry = players.get(id);
    const color = new THREE.Color(p.color || 0x44aa88);

    if (!entry) {
      const group = new THREE.Group();
      const geo = new THREE.SphereGeometry(0.5, 24, 16);
      const mat = new THREE.MeshStandardMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      const label = createNameLabel(p.name || 'Anónimo');
      label.position.set(0, 1.2, 0);
      group.add(label);

      scene.add(group);

      entry = { group, mesh, label, color, name: p.name || 'Anónimo' };
      players.set(id, entry);
    }

    entry.mesh.position.set(p.position.x, p.position.y, p.position.z);
    entry.group.position.copy(entry.mesh.position);
    entry.label.position.set(entry.mesh.position.x, entry.mesh.position.y + 1.2, entry.mesh.position.z);
    entry.name = p.name || entry.name;
    updateLabel(entry.label, entry.name);
  }

  function ensureLocalPlayer() {
    if (localPlayer) return;
    if (!myId) {
      console.warn('[UI] ensureLocalPlayer: aún no hay socket.id');
      return;
    }
    const provisional = {
      name: myName || 'Anónimo',
      color: currentColor || '#44aa88',
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { y: 0 },
    };
    addOrUpdatePlayer(myId, provisional);
    localPlayer = players.get(myId);
    if (localPlayer) {
      controls.target.copy(localPlayer.mesh.position);
      console.log('[UI] Local player provisional creado');
    }
  }

  // Objetos
  function addObjectMesh(obj) {
    let mesh;
    const color = new THREE.Color(obj.color || '#cccccc');
    if (obj.shape === 'sphere') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(obj.size * 0.5, 24, 16),
        new THREE.MeshStandardMaterial({ color })
      );
    } else {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(obj.size, obj.size, obj.size),
        new THREE.MeshStandardMaterial({ color })
      );
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
    mesh.rotation.set(obj.rotation.x || 0, obj.rotation.y || 0, obj.rotation.z || 0);
    scene.add(mesh);
    objectMeshes.set(obj.id, mesh);
  }

  // Label helpers
  function createNameLabel(text) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 12);
    ctx.fill();
    ctx.font = '28px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2.5, 0.6, 1);
    return sprite;
  }

  function updateLabel(sprite, text) {
    const canvas = sprite.material.map.image;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 12);
    ctx.fill();
    ctx.font = '28px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    sprite.material.map.needsUpdate = true;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Movimiento del jugador local
  let lastMoveSentAt = 0;
  function updateMovement(dt) {
    if (!localPlayer) return;
    const speed = 5; // unidades por segundo
    const dir = new THREE.Vector3(
      (keys['KeyD'] ? 1 : 0) + (keys['KeyA'] ? -1 : 0),
      0,
      (keys['KeyS'] ? 1 : 0) + (keys['KeyW'] ? -1 : 0)
    );
    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(speed * dt);
      localPlayer.mesh.position.add(dir);
      localPlayer.group.position.copy(localPlayer.mesh.position);
      localPlayer.label.position.set(localPlayer.mesh.position.x, localPlayer.mesh.position.y + 1.2, localPlayer.mesh.position.z);
      controls.target.copy(localPlayer.mesh.position);
    }

    const now = performance.now();
    if (now - lastMoveSentAt > 66) { // ~15 fps
      socket.emit('player_move', {
        position: {
          x: localPlayer.mesh.position.x,
          y: localPlayer.mesh.position.y,
          z: localPlayer.mesh.position.z,
        },
        rotation: { y: 0 },
      });
      lastMoveSentAt = now;
    }
  }

  // Render loop
  let last = performance.now();
  function animate() {
    const now = performance.now();
    const dt = Math.min(0.033, (now - last) / 1000); // Máx 33ms
    last = now;
    updateMovement(dt);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();

  // Resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();