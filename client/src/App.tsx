import React, { useRef, useState } from 'react';
import VisioCanvas, { VisioHandle } from './VisioCanvas';
import ServiceStatus from './components/ServiceStatus';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function App() {
  const visioRef = useRef<VisioHandle | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  async function save() {
    try {
      await visioRef.current?.saveToServer();
      alert('Gespeichert (Backend)');
    } catch {
      alert('Speichern fehlgeschlagen');
    }
  }

  async function load() {
    await visioRef.current?.loadFromServer();
  }

  return (
    <div className="app" style={{ position: 'relative', height: '100vh', boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        left: 12,
        top: 12,
        bottom: 12,
        zIndex: 20,
        width: sidebarOpen ? 220 : 38,
        maxWidth: sidebarOpen ? 260 : 38,
        transition: 'width 180ms ease',
        background: '#fff',
        borderRight: '1px solid #eee',
        borderRadius: 8,
        boxShadow: '0 4px 10px rgba(0,0,0,0.05)',
        padding: sidebarOpen ? 7 : 4,
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: sidebarOpen ? 6 : 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{sidebarOpen ? 'Systemstatus' : ''}</div>
          <button
            onClick={() => setSidebarOpen(s => !s)}
            style={{
              padding: '3px 4px',
              cursor: 'pointer',
              border: '1px solid #ddd',
              borderRadius: 4,
              background: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title={sidebarOpen ? 'Sidebar einklappen' : 'Sidebar ausklappen'}
          >
            {sidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>

        {sidebarOpen && (
          <>
            <div style={{ marginBottom: 8 }}>
              <ServiceStatus />
            </div>
          </>
        )}
      </div>

      <div style={{ width: '100%', height: '100%', padding: 12, minWidth: 0, minHeight: 0, overflow: 'hidden', boxSizing: 'border-box' }}>
        <VisioCanvas ref={visioRef} />
      </div>
    </div>
  );
}
