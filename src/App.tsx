import { useState } from 'react';
import GoGame from './go/GoGame';
import OmokGame from './omok/OmokGame';

type Tab = 'go' | 'omok';

export default function App() {
  const [tab, setTab] = useState<Tab>('go');

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          <span className="app__title-dot app__title-dot--black" />
          <span className="app__title-dot app__title-dot--white" />
          기보
        </h1>
        <nav className="app__tabs">
          <button className={'app__tab' + (tab === 'go' ? ' on' : '')} onClick={() => setTab('go')}>
            바둑 9×9
          </button>
          <button className={'app__tab' + (tab === 'omok' ? ' on' : '')} onClick={() => setTab('omok')}>
            오목
          </button>
        </nav>
      </header>
      {tab === 'go' ? <GoGame /> : <OmokGame />}
    </div>
  );
}
