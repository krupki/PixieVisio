import React, { useRef } from 'react';
import VisioCanvas, { VisioHandle } from './VisioCanvas';

export default function App() {
  const visioRef = useRef<VisioHandle | null>(null);

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
    <div className="app">
      <div className="toolbar">
        <button onClick={() => visioRef.current?.addNode()}>Kästchen hinzufügen</button>
        <button onClick={save}>Speichern</button>
        <button onClick={load}>Laden</button>
      </div>
      <VisioCanvas ref={visioRef} />
    </div>
  );
}
