import React, { useState, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useNavigate, useSearchParams, Link } from 'react-router-dom';
import logo from '../assets/logo.svg';
import '../assets/styles.css';
import data from '../assets/data.json';
import { Button } from '@/components/Button';

function Page({ children }: { children: ReactNode }) {
  const [n, setN] = useState(0);
  const nav = useNavigate();
  const [params] = useSearchParams();
  useEffect(() => {
    document.title = `${n}`;
  }, [n]);
  return (
    <div onClick={() => { setN(n + 1); nav('/'); }}>
      <img src={logo} alt="" />
      {params.get('q')}
      {data.title}
      <Button label="x" />
      <Link to="/a">a</Link>
      {children}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Page>hi</Page>} />
    </Routes>
  </BrowserRouter>,
);
React.Children.count(null);
React.startTransition(() => {});

export default Page;
