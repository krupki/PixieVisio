import React, { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import * as PIXI from 'pixi.js';

export type NodeState = { id: string; x: number; y: number; text: string };

export type VisioHandle = {
  addNode: () => void;
  exportState: () => { nodes: NodeState[] };
  saveToServer: () => Promise<void>;
  loadFromServer: () => Promise<boolean>;
};

const DEFAULT_BOX = { w: 200, h: 60, radius: 8 };

const VisioCanvas = forwardRef<VisioHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const nodesRef = useRef<
    { id: string; gfx: PIXI.Container; rect: PIXI.Graphics; textObj: PIXI.Text; style: { fill: number; textColor: number } }[]
  >([]);
  const linesRef = useRef<PIXI.Graphics | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formText, setFormText] = useState('');

  // helper to export current state
  function exportNodes(): NodeState[] {
    return nodesRef.current.map(n => ({
      id: n.id,
      x: n.gfx.x,
      y: n.gfx.y,
      text: n.textObj.text
    }));
  }

  // save to backend with modelId
  async function saveToServer(modelId = 'default') {
    try {
      const nodes = exportNodes();
      await fetch('http://localhost:5000/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, nodes })
      });
      console.log('Saved', nodes.length, 'nodes to server');
    } catch (err) {
      console.warn('Save failed', err);
      throw err;
    }
  }

  // debounced trigger to avoid flooding saves during dragging
  function triggerSaveDebounced(delay = 400) {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveToServer().catch(() => {});
      saveTimerRef.current = null;
    }, delay);
  }

  // load from backend; returns true if loaded nodes exist
  async function loadFromServer(modelId = 'default'): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:5000/api/load?modelId=${encodeURIComponent(modelId)}`);
      if (!res.ok) return false;
      const body = await res.json();
      const nodes: NodeState[] = body?.nodes ?? [];
      if (!nodes || nodes.length === 0) return false;

      // clear existing nodes
      for (const n of nodesRef.current) appRef.current?.stage.removeChild(n.gfx);
      nodesRef.current = [];

      // recreate nodes from server state preserving IDs
      for (const s of nodes) {
        addNodeAt(s.x, s.y, s.text, undefined, undefined, s.id);
      }

      refreshSelectionStyles(selectedId);
      return true;
    } catch (err) {
      console.warn('Load failed', err);
      return false;
    }
  }

  useImperativeHandle(ref, () => ({
    addNode,
    exportState: () => ({ nodes: exportNodes() }),
    saveToServer,
    loadFromServer
  }));

  useEffect(() => {
    // robust initialization: guard against missing DOM or PIXI errors
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    try {
      if (!containerRef.current) {
        // container not yet mounted — schedule init on next frame
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
          resolution: dpr
        });
        appRef.current = app;
        // append view safely
        if (containerRef.current && app.view) containerRef.current.appendChild(app.view as HTMLCanvasElement);

        linesRef.current = new PIXI.Graphics();
        app.stage.addChild(linesRef.current);

        // Try to load from server first, fallback to defaults if none
        (async () => {
          const loaded = await loadFromServer();
          if (!loaded) {
            // create defaults and persist them immediately
            addNodeAt(50, 50, 'Control server');
            addNodeAt(300, 50, 'Engineering station');
            addNodeAt(50, 180, 'PLC');
            // ensure persisted
            await saveToServer().catch(() => {});
          }
        })();

        app.ticker.add(() => drawLines());
      } catch (err: any) {
        console.error('Failed to initialize Pixi app', err);
        setInitError(String(err?.message ?? err));
      }
    }

    return () => {
      try {
        appRef.current?.destroy(true, { children: true });
      } catch {}
      appRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function drawLines() {
    const g = linesRef.current!;
    g.clear();
    g.lineStyle(3, 0x333333, 1);
    const arr = nodesRef.current;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i].gfx;
      const b = arr[i + 1].gfx;
      const ax = a.x + DEFAULT_BOX.w;
      const ay = a.y + DEFAULT_BOX.h / 2;
      const bx = b.x;
      const by = b.y + DEFAULT_BOX.h / 2;
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
    }
  }

  function makeDraggable(container: PIXI.Container) {
    container.interactive = true;
    container.cursor = 'grab';

    let dragging = false;
    let data: PIXI.FederatedPointerEvent | null = null;
    let offset = { x: 0, y: 0 };
    container.on('pointerdown', (ev: PIXI.FederatedPointerEvent) => {
      const entry = nodesRef.current.find(n => n.gfx === container);
      if (entry) selectNode(entry.id);
      if (entry) selectNode(entry.id);

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
    });

    const stop = () => {
      dragging = false;
      data = null;
      container.cursor = 'grab';
      // debounce save
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

  // helper: aktualisiert Outline (türkis wenn ausgewählt)
  function refreshSelectionStyles(selId: string | null) {
    const SELECT_COLOR = 0x1abc9c; // türkises Highlight
    const DEFAULT_COLOR = 0x333333;
    const SELECT_WIDTH = 3;
    const DEFAULT_WIDTH = 2;

    for (const n of nodesRef.current) {
      // redraw rect outline while preserving fill
      const fill = n.style.fill;
      n.rect.clear();
      n.rect.beginFill(fill);
      const isSelected = selId !== null && n.id === selId;
      n.rect.lineStyle(isSelected ? SELECT_WIDTH : DEFAULT_WIDTH, isSelected ? SELECT_COLOR : DEFAULT_COLOR);
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
    // bring to front
    appRef.current?.stage.addChild(n.gfx);
    // visual update
    refreshSelectionStyles(id);
  }

  function updateSelectedFromForm() {
    if (!selectedId) return;
    const n = nodesRef.current.find(x => x.id === selectedId);
    if (!n) return;
    n.textObj.text = formText;
    n.textObj.y = (DEFAULT_BOX.h - n.textObj.height) / 2;
    // ensure outline stays correct after label changes
    refreshSelectionStyles(selectedId);
  }

  async function deleteSelected() {
    if (!selectedId) return;
    const idx = nodesRef.current.findIndex(x => x.id === selectedId);
    if (idx === -1) return;
    const n = nodesRef.current[idx];
    appRef.current?.stage.removeChild(n.gfx);
    nodesRef.current.splice(idx, 1);
    setSelectedId(null);
    refreshSelectionStyles(null);
    triggerSaveDebounced();
  }

  // update addNodeAt signature to accept optional id
  function addNodeAt(x: number, y: number, label = '', fill = 0xf4f4f4, textColor = 0x111111, providedId?: string) {
    const app = appRef.current!;
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
            // after label change ensure server has update
            saveToServer().catch(() => {});
          }
        }
        (box as any).__lastTap = now;
        selectNode(entry.id);
      }
    });

    app.stage.addChild(box);
    // use provided id or generate one
    const id = providedId ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    nodesRef.current.push({ id, gfx: box, rect, textObj: text, style: { fill, textColor } });

    // keep outlines consistent (new node gets default outline)
    refreshSelectionStyles(selectedId);
  }

  // Render: if init error show message so page is not blank
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
        {/* ...existing sidebar UI (unchanged) ... */}
        <div style={{ width: 300, padding: 12, background: '#fff', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
          <h3 style={{ marginTop: 0 }}>Editor</h3>
          <div style={{ marginTop: 8 }}>Die Editor-Funktionen sind weiterhin verfügbar.</div>
        </div>
      </div>
    );
  }

  // Normal render
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
        </div>

        <div style={{ borderTop: '1px solid #eee', paddingTop: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Ausgewählt</label>
            <div style={{ minHeight: 28 }}>{selectedId ?? <span style={{ color: '#999' }}>Kein Element</span>}</div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Label</label>
            <input
              value={formText}
              onChange={e => setFormText(e.target.value)}
              onBlur={() => { updateSelectedFromForm(); saveToServer().catch(() => {}); }}
              style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
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
        </div>
      </div>
    </div>
  );
});

export default VisioCanvas;
