import React, { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import * as PIXI from 'pixi.js';

export type NodeState = { id: string; x: number; y: number; text: string; color?: string };
export type ConnectionState = { id: string; fromNodeId: string; toNodeId: string; style?: string; color?: string; width?: number; label?: string };

export type VisioHandle = {
  addNode: () => void;
  exportState: () => { nodes: NodeState[]; connections: ConnectionState[] };
  saveToServer: () => Promise<void>;
  loadFromServer: () => Promise<boolean>;
  addConnection: (fromNodeId: string, toNodeId: string) => void;
};

const DEFAULT_BOX = { w: 200, h: 60, radius: 8 };

const VisioCanvas = forwardRef<VisioHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const nodesRef = useRef<
    { id: string; gfx: PIXI.Container; rect: PIXI.Graphics; textObj: PIXI.Text; style: { fill: number; textColor: number } }[]
  >([]);
  const connectionsRef = useRef<ConnectionState[]>([]);
  const linesRef = useRef<PIXI.Graphics | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<{ active: boolean; fromNodeId?: string }>({ active: false });
  const connectionModeRef = useRef<{ active: boolean; fromNodeId?: string }>({ active: false });

  const updateConnectionMode = (newMode: { active: boolean; fromNodeId?: string }) => {
    connectionModeRef.current = newMode;
    setConnectionMode(newMode);
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formText, setFormText] = useState('');
  const [nodeColor, setNodeColor] = useState('#f4f4f4');
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const stageRef = useRef<PIXI.Container | null>(null);
  const contextLostHandlerRef = useRef<((ev: Event) => void) | null>(null);
  const contextRestoredHandlerRef = useRef<((ev: Event) => void) | null>(null);

  function exportNodes(): NodeState[] {
    return nodesRef.current.map(n => ({
      id: n.id,
      x: n.gfx.x,
      y: n.gfx.y,
      text: n.textObj.text,
      color: `#${n.style.fill.toString(16).padStart(6, '0')}`
    }));
  }

  function exportConnections(): ConnectionState[] {
    return connectionsRef.current;
  }

  async function saveToServer(modelId = 'default') {
    try {
      const nodes = exportNodes();
      const connections = exportConnections();
      
      await fetch('http://localhost:5000/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, nodes, connections })
      });
    } catch (err) {
      throw err;
    }
  }

  function triggerSaveDebounced(delay = 400) {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveToServer().catch(() => {});
      saveTimerRef.current = null;
    }, delay);
  }

  async function loadFromServer(modelId = 'default'): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:5000/api/load?modelId=${encodeURIComponent(modelId)}`);
      if (!res.ok) return false;
      const body = await res.json();
      const nodes: NodeState[] = body?.nodes ?? [];
      const connections: ConnectionState[] = body?.connections ?? [];

      for (const n of nodesRef.current) stageRef.current?.removeChild(n.gfx);
      nodesRef.current = [];

      for (const s of nodes) {
        const fillColor = s.color ? parseInt(s.color.replace('#', ''), 16) : 0xf4f4f4;
        addNodeAt(s.x, s.y, s.text, fillColor, undefined, s.id);
      }

      connectionsRef.current = connections;
      refreshSelectionStyles(selectedId);
      drawLines();
      
      return true;
    } catch (err) {
      console.warn('Load failed', err);
      return false;
    }
  }

  function addConnection(fromNodeId: string, toNodeId: string) {
    if (fromNodeId === toNodeId) return;
    
    const fromNode = nodesRef.current.find(n => n.id === fromNodeId);
    const toNode = nodesRef.current.find(n => n.id === toNodeId);
    
    if (!fromNode || !toNode) return;
    
    const existsAlready = connectionsRef.current.some(c => 
      (c.fromNodeId === fromNodeId && c.toNodeId === toNodeId) ||
      (c.fromNodeId === toNodeId && c.toNodeId === fromNodeId)
    );
    
    if (existsAlready) return;

    const newConnection: ConnectionState = {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fromNodeId,
      toNodeId,
      style: 'solid',
      color: '#333333',
      width: 3
    };

    connectionsRef.current.push(newConnection);
    nodesRef.current.forEach(n => n.gfx.cursor = 'grab');
    refreshSelectionStyles(selectedId, { active: false });
    drawLines();
    triggerSaveDebounced();
  }

  useImperativeHandle(ref, () => ({
    addNode,
    exportState: () => ({ nodes: exportNodes(), connections: exportConnections() }),
    saveToServer,
    loadFromServer,
    addConnection
  }));

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        updateConnectionMode({ active: false });
        nodesRef.current.forEach(n => n.gfx.cursor = 'grab');
        refreshSelectionStyles(selectedId, { active: false });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId]);

  useEffect(() => {
    refreshSelectionStyles(selectedId);
  }, [connectionMode]);

  useEffect(() => {
    if (linesRef.current) {
      drawLines();
    }
  }, [selectedConnection]);

  function setupZoomAndPan(app: PIXI.Application, stage: PIXI.Container) {
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let stageStart = { x: 0, y: 0 };
    
    const canvas = app.view as HTMLCanvasElement;
    canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const currentZoom = stage.scale.x;
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.1, Math.min(5, currentZoom * zoomFactor));
      
      const worldPos = {
        x: (mouseX - stage.x) / stage.scale.x,
        y: (mouseY - stage.y) / stage.scale.y
      };
      
      stage.scale.set(newZoom);
      stage.x = mouseX - worldPos.x * newZoom;
      stage.y = mouseY - worldPos.y * newZoom;
      
      setZoomLevel(newZoom);
    });
    
    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        e.preventDefault();
        isDragging = true;
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;
        stageStart.x = stage.x;
        stageStart.y = stage.y;
        canvas.style.cursor = 'grabbing';
      }
    });
    
    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        stage.x = stageStart.x + dx;
        stage.y = stageStart.y + dy;
      }
    });
    
    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      canvas.style.cursor = 'default';
    });
    
    canvas.addEventListener('mouseleave', () => {
      isDragging = false;
      canvas.style.cursor = 'default';
    });
  }

  function resetZoom() {
    if (stageRef.current) {
      stageRef.current.scale.set(1);
      stageRef.current.x = 0;
      stageRef.current.y = 0;
      setZoomLevel(1);
    }
  }

  function zoomIn() {
    if (stageRef.current && appRef.current) {
      const currentZoom = stageRef.current.scale.x;
      const newZoom = Math.min(5, currentZoom * 1.2);
      const centerX = appRef.current.screen.width / 2;
      const centerY = appRef.current.screen.height / 2;
      
      const worldPos = {
        x: (centerX - stageRef.current.x) / stageRef.current.scale.x,
        y: (centerY - stageRef.current.y) / stageRef.current.scale.y
      };
      
      stageRef.current.scale.set(newZoom);
      stageRef.current.x = centerX - worldPos.x * newZoom;
      stageRef.current.y = centerY - worldPos.y * newZoom;
      
      setZoomLevel(newZoom);
    }
  }

  function zoomOut() {
    if (stageRef.current && appRef.current) {
      const currentZoom = stageRef.current.scale.x;
      const newZoom = Math.max(0.1, currentZoom * 0.8);
      const centerX = appRef.current.screen.width / 2;
      const centerY = appRef.current.screen.height / 2;
      
      const worldPos = {
        x: (centerX - stageRef.current.x) / stageRef.current.scale.x,
        y: (centerY - stageRef.current.y) / stageRef.current.scale.y
      };
      
      stageRef.current.scale.set(newZoom);
      stageRef.current.x = centerX - worldPos.x * newZoom;
      stageRef.current.y = centerY - worldPos.y * newZoom;
      
      setZoomLevel(newZoom);
    }
  }

  useEffect(() => {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const DPR_CAP = 1.5;
  const effectiveDpr = Math.min(dpr, DPR_CAP);

    try {
      if (!containerRef.current) {
        const t = requestAnimationFrame(() => initPixi());
        return () => cancelAnimationFrame(t);
      }
      initPixi();
    } catch (err: any) {
      console.error('Pixi init error', err);
      setInitError(String(err?.message ?? err));
    }

    function initPixi() {
      try {
        const app = new PIXI.Application({
          backgroundColor: 0xf6f8fa,
          resizeTo: containerRef.current || undefined,
          antialias: true,
          autoDensity: true,
          resolution: effectiveDpr,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: false
        });
        appRef.current = app;
        if (containerRef.current && app.view) containerRef.current.appendChild(app.view as HTMLCanvasElement);

        const stage = new PIXI.Container();
        stageRef.current = stage;
        app.stage.addChild(stage);

        linesRef.current = new PIXI.Graphics();
        stage.addChild(linesRef.current);

        setupZoomAndPan(app, stage);
        const canvas = app.view as HTMLCanvasElement;
        const onContextLost = (ev: Event) => {
          try {
            ev.preventDefault();
          } catch {}
          console.warn('WebGL context lost');
          try {
            app.ticker.stop();
          } catch {}
        };

        const onContextRestored = (ev: Event) => {
          console.info('WebGL context restored — reinitializing Pixi app');
          try {
            app.destroy(true, { children: true });
          } catch (err) {
            console.warn('Error destroying Pixi app after context restore', err);
          }

          appRef.current = null;
          stageRef.current = null;
          linesRef.current = null;

          setTimeout(() => {
            try {
              initPixi();
            } catch (err) {
              console.error('Failed to reinitialize Pixi after context restore', err);
              setInitError(String((err as any)?.message ?? err));
            }
          }, 80);
        };

  contextLostHandlerRef.current = onContextLost;
  contextRestoredHandlerRef.current = onContextRestored;
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

        (async () => {
          const loaded = await loadFromServer();
          if (!loaded) {
            addNodeAt(50, 50, 'Control server');
            addNodeAt(300, 50, 'Engineering station');
            addNodeAt(50, 180, 'PLC');
            await saveToServer().catch(() => {});
          }
        })();
      } catch (err: any) {
        console.error('Failed to initialize Pixi app', err);
        setInitError(String(err?.message ?? err));
      }
    }

    return () => {
      try {
        try {
          const cvs = appRef.current?.view as HTMLCanvasElement | undefined;
          if (cvs) {
            const lost = contextLostHandlerRef.current;
            const restored = contextRestoredHandlerRef.current;
            if (lost) cvs.removeEventListener('webglcontextlost', lost);
            if (restored) cvs.removeEventListener('webglcontextrestored', restored);
            contextLostHandlerRef.current = null;
            contextRestoredHandlerRef.current = null;
          }
        } catch {}

        appRef.current?.destroy(true, { children: true });
      } catch {}
      appRef.current = null;
    };
  }, []);

  function drawLines() {
    const g = linesRef.current!;
    g.clear();
    g.removeAllListeners();
    
    for (const connection of connectionsRef.current) {
      const fromNode = nodesRef.current.find(n => n.id === connection.fromNodeId);
      const toNode = nodesRef.current.find(n => n.id === connection.toNodeId);
      
      if (!fromNode || !toNode) continue;
      
      const color = connection.color ? parseInt(connection.color.replace('#', ''), 16) : 0x333333;
      const width = connection.width || 3;
      const isSelected = selectedConnection === connection.id;
      
      g.lineStyle(isSelected ? width + 4 : width, isSelected ? 0xff6b35 : color, 1);
      
      const fromX = fromNode.gfx.x + DEFAULT_BOX.w;
      const fromY = fromNode.gfx.y + DEFAULT_BOX.h / 2;
      const toX = toNode.gfx.x;
      const toY = toNode.gfx.y + DEFAULT_BOX.h / 2;
      
      g.moveTo(fromX, fromY);
      g.lineTo(toX, toY);
      
      const angle = Math.atan2(toY - fromY, toX - fromX);
      const arrowLength = 12;
      const arrowAngle = Math.PI / 6;
      
      g.lineTo(
        toX - arrowLength * Math.cos(angle - arrowAngle),
        toY - arrowLength * Math.sin(angle - arrowAngle)
      );
      g.moveTo(toX, toY);
      g.lineTo(
        toX - arrowLength * Math.cos(angle + arrowAngle),
        toY - arrowLength * Math.sin(angle + arrowAngle)
      );
    }
    
    g.eventMode = 'static';
    g.cursor = 'default';
    g.hitArea = new PIXI.Rectangle(0, 0, appRef.current?.screen.width || 800, appRef.current?.screen.height || 600);
    
    g.on('pointerdown', (ev: PIXI.FederatedPointerEvent) => {
      const pos = ev.data.getLocalPosition(g);
      
      let closestConnection: string | null = null;
      let minDistance = Infinity;
      const maxClickDistance = 15;
      
      for (const connection of connectionsRef.current) {
        const fromNode = nodesRef.current.find(n => n.id === connection.fromNodeId);
        const toNode = nodesRef.current.find(n => n.id === connection.toNodeId);
        
        if (!fromNode || !toNode) continue;
        
        const fromX = fromNode.gfx.x + DEFAULT_BOX.w;
        const fromY = fromNode.gfx.y + DEFAULT_BOX.h / 2;
        const toX = toNode.gfx.x;
        const toY = toNode.gfx.y + DEFAULT_BOX.h / 2;
        
        const distance = distanceToLine(pos.x, pos.y, fromX, fromY, toX, toY);
        
        if (distance < maxClickDistance && distance < minDistance) {
          minDistance = distance;
          closestConnection = connection.id;
        }
      }
      
      setSelectedConnection(closestConnection);
      ev.stopPropagation();
    });
  }

  function distanceToLine(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;
    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function makeDraggable(container: PIXI.Container) {
    container.eventMode = 'static';
    container.cursor = 'grab';

    let dragging = false;
    let data: PIXI.FederatedPointerEvent | null = null;
    let offset = { x: 0, y: 0 };
    container.on('pointerdown', (ev: PIXI.FederatedPointerEvent) => {
      const entry = nodesRef.current.find(n => n.gfx === container);
      if (entry) {
        selectNode(entry.id);
        
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          ev.stopPropagation();
          
          if (connectionModeRef.current.active && connectionModeRef.current.fromNodeId && connectionModeRef.current.fromNodeId !== entry.id) {
            addConnection(connectionModeRef.current.fromNodeId, entry.id);
            updateConnectionMode({ active: false });
          } else if (connectionModeRef.current.active && connectionModeRef.current.fromNodeId === entry.id) {
            updateConnectionMode({ active: false });
            nodesRef.current.forEach(n => n.gfx.cursor = 'grab');
            refreshSelectionStyles(selectedId, { active: false });
          } else {
            const newConnectionMode = { active: true, fromNodeId: entry.id };
            updateConnectionMode(newConnectionMode);
            refreshSelectionStyles(selectedId, newConnectionMode);
            
            nodesRef.current.forEach(n => {
              if (n.id === entry.id) {
                n.gfx.cursor = 'crosshair';
              } else {
                n.gfx.cursor = 'pointer';
              }
            });
          }
          return;
        }
        
        if (connectionModeRef.current.active && connectionModeRef.current.fromNodeId && connectionModeRef.current.fromNodeId !== entry.id) {
          addConnection(connectionModeRef.current.fromNodeId, entry.id);
          updateConnectionMode({ active: false });
          nodesRef.current.forEach(n => n.gfx.cursor = 'grab');
          refreshSelectionStyles(selectedId, { active: false });
          return;
        }
        
        if (connectionModeRef.current.active && connectionModeRef.current.fromNodeId === entry.id) {
          updateConnectionMode({ active: false });
          nodesRef.current.forEach(n => n.gfx.cursor = 'grab');
          refreshSelectionStyles(selectedId, { active: false });
          return;
        }
      }

      dragging = true;
      container.cursor = 'grabbing';
      data = ev.data;
      const pos = data.getLocalPosition(container.parent!);
      offset.x = pos.x - container.x;
      offset.y = pos.y - container.y;
    });

    container.on('pointermove', () => {
      if (!dragging || !data) return;
      const pos = data.getLocalPosition(container.parent!);
      container.x = pos.x - offset.x;
      container.y = pos.y - offset.y;
      drawLines();
    });

    const stop = () => {
      dragging = false;
      data = null;
      container.cursor = 'grab';
      drawLines();
      triggerSaveDebounced();
    };

    container.on('pointerup', stop);
    container.on('pointerupoutside', stop);
  }

  let counter = 0;
  function addNode() {
    addNodeAt(100 + counter * 40, 100 + counter * 30, `Node ${counter + 1}`);
    counter++;
    triggerSaveDebounced();
  }

  function refreshSelectionStyles(selId: string | null, overrideConnectionMode?: { active: boolean; fromNodeId?: string }) {
    const SELECT_COLOR = 0x1abc9c;
    const DEFAULT_COLOR = 0x333333;
    const CONNECTION_COLOR = 0xf39c12;
    const SELECT_WIDTH = 3;
    const DEFAULT_WIDTH = 2;
    const CONNECTION_WIDTH = 4;

    const currentConnectionMode = overrideConnectionMode || connectionMode;

    for (const n of nodesRef.current) {
      const fill = n.style.fill;
      n.rect.clear();
      n.rect.beginFill(fill);
      
      const isSelected = selId !== null && n.id === selId;
      const isConnectionStart = currentConnectionMode.active && currentConnectionMode.fromNodeId === n.id;
      
      let borderColor = DEFAULT_COLOR;
      let borderWidth = DEFAULT_WIDTH;
      
      if (isSelected) {
        borderColor = SELECT_COLOR;
        borderWidth = SELECT_WIDTH;
      } else if (isConnectionStart) {
        borderColor = CONNECTION_COLOR;
        borderWidth = CONNECTION_WIDTH;
      }
      
      n.rect.lineStyle(borderWidth, borderColor);
      n.rect.drawRoundedRect(0, 0, DEFAULT_BOX.w, DEFAULT_BOX.h, DEFAULT_BOX.radius);
      n.rect.endFill();
    }
  }

  function selectNode(id: string | null) {
    setSelectedId(id);
    if (!id) {
      refreshSelectionStyles(null);
      return;
    }
    const n = nodesRef.current.find(x => x.id === id);
    if (!n) return;
    setFormText(n.textObj.text);
    setNodeColor(`#${n.style.fill.toString(16).padStart(6, '0')}`);
    stageRef.current?.addChild(n.gfx);
    refreshSelectionStyles(id);
  }

  function updateSelectedFromForm() {
    if (!selectedId) return;
    const n = nodesRef.current.find(x => x.id === selectedId);
    if (!n) return;
    n.textObj.text = formText;
    n.textObj.y = (DEFAULT_BOX.h - n.textObj.height) / 2;
    
    const newFillColor = parseInt(nodeColor.replace('#', ''), 16);
    n.style.fill = newFillColor;
    refreshSelectionStyles(selectedId);
  }

  async function deleteSelected() {
    if (!selectedId) return;
    const idx = nodesRef.current.findIndex(x => x.id === selectedId);
    if (idx === -1) return;
    const n = nodesRef.current[idx];
    stageRef.current?.removeChild(n.gfx);
    nodesRef.current.splice(idx, 1);
    
    connectionsRef.current = connectionsRef.current.filter(c => 
      c.fromNodeId !== selectedId && c.toNodeId !== selectedId
    );
    
    setSelectedId(null);
    refreshSelectionStyles(null);
    triggerSaveDebounced();
  }

  function deleteConnection(connectionId: string) {
    connectionsRef.current = connectionsRef.current.filter(c => c.id !== connectionId);
    if (selectedConnection === connectionId) {
      setSelectedConnection(null);
    }
    drawLines();
    triggerSaveDebounced();
  }

  function addNodeAt(x: number, y: number, label = '', fill = 0xf4f4f4, textColor = 0x111111, providedId?: string) {
    const app = appRef.current!;
    const stage = stageRef.current!;
    const box = new PIXI.Container();
    box.x = x;
    box.y = y;

    const rect = new PIXI.Graphics();
    rect.beginFill(fill);
    rect.lineStyle(2, 0x333333);
    rect.drawRoundedRect(0, 0, DEFAULT_BOX.w, DEFAULT_BOX.h, DEFAULT_BOX.radius);
    rect.endFill();

    const text = new PIXI.Text(label || `Node ${nodesRef.current.length + 1}`, {
      fill: textColor,
      fontSize: 18,
      fontWeight: '600'
    });
    text.x = 20;
    text.y = (DEFAULT_BOX.h - text.height) / 2;

    box.addChild(rect);
    box.addChild(text);

    makeDraggable(box);

    box.on('pointertap', () => {
      const entry = nodesRef.current.find(n => n.gfx === box);
      if (entry) {
        const now = performance.now();
        if ((box as any).__lastTap && now - (box as any).__lastTap < 300) {
          const newLabel = prompt('Label', entry.textObj.text);
          if (newLabel !== null) {
            entry.textObj.text = newLabel;
            if (selectedId === entry.id) setFormText(newLabel);
            saveToServer().catch(() => {});
          }
        }
        (box as any).__lastTap = now;
        selectNode(entry.id);
      }
    });

    stage.addChild(box);
    const id = providedId ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    nodesRef.current.push({ id, gfx: box, rect, textObj: text, style: { fill, textColor } });

    refreshSelectionStyles(selectedId);
  }

  function isNodeVisible(x: number, y: number, stage: PIXI.Container, app: PIXI.Application) {
    const zoom = stage.scale.x;
    const offsetX = stage.x;
    const offsetY = stage.y;
    const canvasWidth = app.screen.width;
    const canvasHeight = app.screen.height;

    // Transformiere Node-Koordinaten in Canvas-Koordinaten
    const nodeCanvasX = x * zoom + offsetX;
    const nodeCanvasY = y * zoom + offsetY;

    // Prüfe, ob Node im sichtbaren Bereich liegt
    return (
      nodeCanvasX + DEFAULT_BOX.w * zoom > 0 &&
      nodeCanvasX < canvasWidth &&
      nodeCanvasY + DEFAULT_BOX.h * zoom > 0 &&
      nodeCanvasY < canvasHeight
    );
  }

  if (initError) {
    return (
      <div style={{ display: 'flex', height: '80vh', gap: 12 }}>
        <div style={{ flex: 1, minHeight: 0, borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#b00020' }}>
            <h3>Initialisierungsfehler</h3>
            <div style={{ whiteSpace: 'pre-wrap' }}>{initError}</div>
            <div style={{ marginTop: 8, color: '#666' }}>Konsole prüfen (Server/Browser).</div>
          </div>
        </div>

        <div style={{ width: 300, padding: 12, background: '#fff', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
          <h3 style={{ marginTop: 0 }}>Editor</h3>
          <div style={{ marginTop: 8 }}>Die Editor-Funktionen sind weiterhin verfügbar.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '80vh', gap: 12 }}>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, borderRadius: 6, overflow: 'hidden' }} />
      <div style={{ width: 300, padding: 12, background: '#fff', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
        <h3 style={{ marginTop: 0 }}>Editor</h3>

        <div style={{ marginBottom: 8 }}>
          <button onClick={() => { addNode(); }} style={{ padding: '8px 12px', cursor: 'pointer' }}>
            Kästchen hinzufügen
          </button>
          <button
            onClick={async () => { await loadFromServer(); }}
            style={{ padding: '8px 12px', marginLeft: 8, cursor: 'pointer' }}
          >
            Laden
          </button>
          <button
            onClick={async () => { await saveToServer(); alert('Gespeichert'); }}
            style={{ padding: '8px 12px', marginLeft: 8, cursor: 'pointer' }}
          >
            Speichern
          </button>
          <button
            onClick={() => {
              const nodes = nodesRef.current;
              if (nodes.length >= 2) {
                addConnection(nodes[0].id, nodes[1].id);
              } else {
                alert('Benötige mindestens 2 Nodes für Test');
              }
            }}
            style={{ padding: '6px 8px', marginLeft: 8, cursor: 'pointer', backgroundColor: '#4CAF50', color: 'white', fontSize: '10px' }}
          >
            Test
          </button>
        </div>

        <div style={{ marginBottom: 8, padding: 8, backgroundColor: '#f8f9fa', borderRadius: 4 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Zoom & Navigation</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <button
              onClick={zoomIn}
              style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12 }}
              title="Reinzoomen"
            >
              🔍+
            </button>
            <button
              onClick={zoomOut}
              style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12 }}
              title="Rauszoomen"
            >
              🔍-
            </button>
            <button
              onClick={resetZoom}
              style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12 }}
              title="Zoom zurücksetzen"
            >
              🎯
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#666' }}>
            Zoom: {Math.round(zoomLevel * 100)}%
          </div>
          <div style={{ fontSize: 9, color: '#999', marginTop: 2 }}>
            💡 Mausrad zum Zoomen, Shift+Drag oder mittlere Maustaste zum Verschieben
          </div>
        </div>

        <div style={{ borderTop: '1px solid #eee', paddingTop: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Ausgewählt</label>
            <div style={{ minHeight: 28 }}>{selectedId ?? <span style={{ color: '#999' }}>Kein Element</span>}</div>
          </div>

          {connectionMode.active && (
            <div style={{ marginBottom: 8, padding: 8, backgroundColor: '#e3f2fd', borderRadius: 4 }}>
              <div style={{ fontSize: 12, color: '#1976d2' }}>
                🔗 Verbindungsmodus aktiv
              </div>
              <div style={{ fontSize: 11, color: '#666' }}>
                Klicken Sie auf einen anderen Node oder ESC zum Abbrechen
              </div>
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Label</label>
            <input
              value={formText}
              onChange={e => setFormText(e.target.value)}
              onBlur={() => { updateSelectedFromForm(); saveToServer().catch(() => {}); }}
              style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Farbe</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="color"
                value={nodeColor}
                onChange={e => setNodeColor(e.target.value)}
                onBlur={() => { updateSelectedFromForm(); saveToServer().catch(() => {}); }}
                style={{ width: 40, height: 32, border: 'none', borderRadius: 4, cursor: 'pointer' }}
              />
              <input
                type="text"
                value={nodeColor}
                onChange={e => setNodeColor(e.target.value)}
                style={{ flex: 1, padding: 8, boxSizing: 'border-box', fontSize: 12 }}
                placeholder="#f4f4f4"
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              onClick={() => {
                updateSelectedFromForm();
              }}
              style={{ flex: 1, padding: '8px 12px', cursor: 'pointer' }}
            >
              Anwenden
            </button>
            <button
              onClick={() => {
                deleteSelected();
              }}
              style={{ flex: 1, padding: '8px 12px', cursor: 'pointer', background: '#ff6b6b', color: '#fff', border: 'none' }}
            >
              Löschen
            </button>
          </div>

          <div style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Verbindungen</div>
            <div style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>
              <div>📖 Anleitung:</div>
              <div>1. Strg/Cmd + Klick auf ersten Node (wird orange)</div>
              <div>2. Strg/Cmd + Klick auf zweiten Node</div>
              <div>3. Oder: Button "Verbindungsmodus" → 2x klicken</div>
            </div>
            <button
              onClick={() => {
                const newMode = { active: !connectionMode.active };
                updateConnectionMode(newMode);
                if (!newMode.active) {
                  nodesRef.current.forEach(n => n.gfx.cursor = 'grab');
                  refreshSelectionStyles(selectedId, newMode);
                }

              }}
              style={{
                width: '100%',
                padding: '6px 12px',
                cursor: 'pointer',
                backgroundColor: connectionMode.active ? '#1976d2' : '#f5f5f5',
                color: connectionMode.active ? '#fff' : '#333',
                border: '1px solid #ddd',
                borderRadius: 4
              }}
            >
              {connectionMode.active ? 'Verbindungsmodus beenden' : 'Verbindungsmodus'}
            </button>
            
            <div style={{ marginTop: 8, fontSize: 11, color: '#666' }}>
              Verbindungen: {connectionsRef.current.length}
              
              {/* Button um alle Verbindungen zu löschen */}
              {connectionsRef.current.length > 0 && (
                <button
                  onClick={() => {
                    connectionsRef.current = [];
                    setSelectedConnection(null);
                    drawLines();
                    triggerSaveDebounced();
                  }}
                  style={{
                    marginTop: 4,
                    padding: '4px 8px',
                    fontSize: 10,
                    backgroundColor: '#6c757d',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                    display: 'block'
                  }}
                >
                  Alle Verbindungen löschen
                </button>
              )}
              
              {selectedConnection && (
                <div style={{ marginTop: 6, padding: 6, backgroundColor: '#fff3cd', borderRadius: 3, border: '1px solid #ffeaa7' }}>
                  <div style={{ fontSize: 10, color: '#856404', marginBottom: 4 }}>
                    🎯 Verbindung ausgewählt
                  </div>
                  <div style={{ fontSize: 9, color: '#666', marginBottom: 4 }}>
                    ID: {selectedConnection.substring(0, 12)}...
                  </div>
                  <button
                    onClick={() => deleteConnection(selectedConnection)}
                    style={{
                      padding: '4px 8px',
                      fontSize: 10,
                      backgroundColor: '#dc3545',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 3,
                      cursor: 'pointer',
                      width: '100%'
                    }}
                  >
                    Diese Verbindung löschen
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default VisioCanvas;

function createNodeTexture(label: string, fill: number, textColor: number, app: PIXI.Application): PIXI.Texture {
  const gfx = new PIXI.Graphics();
  gfx.beginFill(fill);
  gfx.lineStyle(2, 0x333333);
  gfx.drawRoundedRect(0, 0, DEFAULT_BOX.w, DEFAULT_BOX.h, DEFAULT_BOX.radius);
  gfx.endFill();

  const text = new PIXI.Text(label, {
    fill: textColor,
    fontSize: 18,
    fontWeight: '600'
  });
  text.x = 20;
  text.y = (DEFAULT_BOX.h - text.height) / 2;
  gfx.addChild(text);

  // Texture aus Graphics generieren
  return app.renderer.generateTexture(gfx);
}
