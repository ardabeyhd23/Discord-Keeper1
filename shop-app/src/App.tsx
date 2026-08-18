import React from 'react';

const products = [
  {name:'VIP Role', price:5000, type:'VIP'},
  {name:'Daily Special', price:1000, type:'Günün Ürünü'},
  {name:'Robux 100', price:0, type:'Robux', locked:true},
  {name:'Robux 1000', price:0, type:'Robux', locked:true},
];

export default function App(){
  return (
    <main style={{background:'#0f172a',color:'white',minHeight:'100vh',padding:24,fontFamily:'Inter, sans-serif'}}>
      <header style={{display:'flex',gap:16,alignItems:'center',background:'#1e293b',padding:16,borderRadius:18}}>
        <div style={{width:56,height:56,borderRadius:'50%',background:'#334155'}} />
        <div>
          <b>Discord User</b><br/>
          <span>@username</span>
        </div>
        <div style={{marginLeft:'auto'}}>💰 0 Coin</div>
      </header>

      <h1>🛒 FR Family Shop</h1>
      <p>Modern Discord Activity mağaza arayüzü</p>

      <section style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:16}}>
        {products.map(p=>(
          <article key={p.name} style={{background:'#1e293b',padding:18,borderRadius:18}}>
            <h3>{p.name}</h3>
            <p>{p.type}</p>
            <p>{p.locked ? '🔒 Yakında aktif olacak' : `${p.price} 🪙`}</p>
            <button disabled={p.locked}>{p.locked?'Kapalı':'Satın Al'}</button>
          </article>
        ))}
      </section>

      <hr style={{margin:'24px 0'}}/>
      <div>🏆 Seviye Sistemi • 🥇 Mağaza Sıralaması • 🎁 Günün Ürünü • 🔥 Haftalık İndirim</div>
    </main>
  );
}
