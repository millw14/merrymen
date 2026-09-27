import numpy as np, wave
SR=44100; D=65.0; N=int(SR*D)
L=np.zeros(N); R=np.zeros(N)
rng=np.random.default_rng(7)
def add(sig,t,gain=1.0,pan=0.0):
    i=int(t*SR); j=min(N,i+len(sig))
    if i>=N: return
    s=sig[:j-i]*gain
    L[i:j]+=s*(1-max(0,pan)); R[i:j]+=s*(1+min(0,pan))
def env(n,a,d):  # attack secs, exp decay tau
    t=np.arange(n)/SR; return np.minimum(1,t/max(a,1e-4))*np.exp(-t/d)
def lp_fast(x,cut):
    # FFT brickwall-ish lowpass
    X=np.fft.rfft(x); f=np.fft.rfftfreq(len(x),1/SR); X*=1/(1+(f/cut)**4); return np.fft.irfft(X,len(x))
def hp_fast(x,cut):
    X=np.fft.rfft(x); f=np.fft.rfftfreq(len(x),1/SR); X*=1/(1+(cut/np.maximum(f,1))**4); return np.fft.irfft(X,len(x))
def kick(g=1.0,big=False):
    n=int(SR*(0.9 if big else 0.45)); t=np.arange(n)/SR
    f=45+ (140 if big else 110)*np.exp(-t*(18 if big else 30))
    ph=2*np.pi*np.cumsum(f)/SR
    s=np.sin(ph)*np.exp(-t*(3.2 if big else 7))
    s+=0.25*rng.standard_normal(n)*np.exp(-t*120)
    return np.tanh(s*1.6)*g
def hat(g=.2,dec=.04):
    n=int(SR*.15); s=hp_fast(rng.standard_normal(n),7000)*np.exp(-np.arange(n)/SR/dec); return s*g
def clap(g=.35):
    n=int(SR*.35); t=np.arange(n)/SR; s=hp_fast(rng.standard_normal(n),1200)
    e=np.exp(-t/.09)+ (t<.03)*np.exp(-((t%.01)/.003))
    return lp_fast(s*e,6000)*g
def whoosh(dur=.8,g=.35,up=True):
    n=int(SR*dur); t=np.arange(n)/SR; x=rng.standard_normal(n)
    # sweep via chunked bandpass approximation: mix lp noise with rising cutoff
    out=np.zeros(n); seg=int(SR*.05)
    for k in range(0,n,seg):
        fr=k/n if up else 1-k/n
        c=300+ 7000*fr**2
        chunk=x[k:k+seg+256]; y=lp_fast(chunk,c)[:min(seg,n-k)]; out[k:k+len(y)]=y
    e=np.sin(np.pi*np.clip(t/dur,0,1))**2 if up else np.exp(-t/(dur/3))
    return out*e*g
def riser(dur=2.0,g=.3):
    n=int(SR*dur); t=np.arange(n)/SR; p=t/dur
    f=200+1800*p**2; s=np.sin(2*np.pi*np.cumsum(f)/SR)*0.25
    noise=hp_fast(rng.standard_normal(n),2000)*0.5
    return (s+noise)*p**2.5*g
def click(g=.5):
    n=int(SR*.06); t=np.arange(n)/SR
    return (np.sin(2*np.pi*2200*t)*np.exp(-t/.006)+hp_fast(rng.standard_normal(n),3000)*np.exp(-t/.004)*.6)*g
def tick(g=.12):
    n=int(SR*.03); t=np.arange(n)/SR
    return hp_fast(rng.standard_normal(n),4000)*np.exp(-t/.003)*g
def pluck(freq,dur=.6,g=.25):
    n=int(SR*dur); t=np.arange(n)/SR
    s=np.sin(2*np.pi*freq*t)+.35*np.sin(2*np.pi*2*freq*t)+.15*np.sin(2*np.pi*3*freq*t)
    return s*env(n,.004,dur/4)*g
def impact(g=.9):
    n=int(SR*2.5); t=np.arange(n)/SR
    boom=np.sin(2*np.pi*np.cumsum(38+60*np.exp(-t*8))/SR)*np.exp(-t*1.4)
    ns=lp_fast(rng.standard_normal(n),2500)*np.exp(-t*3)*.5
    return np.tanh((boom+ns)*1.4)*g
def mtof(m): return 440*2**((m-69)/12)

BPM=120; B=60/BPM
# chords Am F C G (midi)
CH=[[57,60,64],[53,57,60],[48,55,60,64],[55,59,62]]
BASS=[45,41,36,43]
# --- pad: whole track
pad=np.zeros(N); t=np.arange(N)/SR
for bar in range(int(D/2)+1):
    ch=CH[bar%4]; t0=bar*2.0; i0=int(t0*SR); n=int(2.3*SR)
    if i0>=N: break
    tt=np.arange(n)/SR; e=np.minimum(1,tt/.4)*np.minimum(1,np.maximum(0,(2.3-tt)/.4))
    s=np.zeros(n)
    for m in ch:
        for det in (-0.08,0.0,0.08):
            f=mtof(m+12)*(1+det/100*3)
            s+=2*(tt*f%1)-1
    s=s/len(ch)/3*e
    j=min(N,i0+n); pad[i0:j]+=s[:j-i0]
pad=lp_fast(pad,1400)
# pad level automation
padlvl=np.interp(t,[0,1.5,5.5,6,10.5,52.4,53,58.5,59,63,65],[0,.10,.16,.08,.10,.10,.14,.12,.18,.14,0])
# sidechain from kicks
sc=np.ones(N)
beats=[]
for k in range(int(10.5/B),int(52.5/B)): beats.append(k*B)
for k in range(int(58.5/B)+1,int(62.5/B)): pass
for bt in beats:
    i=int(bt*SR); n=int(.35*SR); j=min(N,i+n); sc[i:j]=np.minimum(sc[i:j],1-.7*np.exp(-np.arange(j-i)/SR/.09))
pad*=padlvl*sc
L+=pad*.9; R+=pad
# arp shimmer in intro and outro
for k in range(int(0.5/ (B/2)), int(6/(B/2))):
    tt=k*B/2; ch=CH[int(tt//2)%4]; m=ch[k%len(ch)]+24
    add(pluck(mtof(m),.5,.06*min(1,tt/2)),tt,pan=(-.4 if k%2 else .4))
for k in range(int(58.6/(B/2)), int(63.5/(B/2))):
    tt=k*B/2; ch=CH[int(tt//2)%4]; m=ch[k%len(ch)]+24
    add(pluck(mtof(m),.6,.07),tt,pan=(-.4 if k%2 else .4))
# groove 10.5-52.5 (lighter 52.5-58.5)
for bt in beats:
    add(kick(.85),bt)
    k=round(bt/B)
    add(hat(.10),bt+B/2,pan=.3)
    if k%2==1: add(clap(.28),bt)
    if k%4==3: add(hat(.07,.02),bt+B*.75,pan=-.3)
    # bass: 8th notes
    bar=int(bt//2); m=BASS[bar%4]
    for h in (0,B/2):
        n=int(SR*B/2*.95); tt=np.arange(n)/SR; f=mtof(m)
        s=(2*(tt*f%1)-1); s=lp_fast(s,500+300*(h>0))*np.exp(-tt/.18)*.22
        add(s,bt+h)
# safety section: half-time
for k in range(int(52.5/B),int(58.5/B)):
    bt=k*B
    if k%2==0: add(kick(.8),bt)
    add(hat(.06),bt+B/2,pan=.3)
    if k%4==2: add(clap(.25),bt)
# kinetic slams
for bt in (6,7,8,9): add(kick(1.0,big=True),bt); add(clap(.3),bt)
add(riser(2.2,.25),3.8); add(impact(.9),6.0)
add(impact(.5),3.9)
add(riser(1.4,.2),9.2); add(impact(.6),10.5)
for tt in (10.2,16.5,23.7,28.1,31.1,46.6,52.2,58.2):
    add(whoosh(.9,.35),tt,pan=0)
add(riser(1.5,.22),57.1); add(impact(1.0),58.6)
# logo bar ticks intro
for i in range(19):
    d=.55+((i*7)%19)*.035; add(tick(.08),d+.05,pan=(-.5 if i%2 else .5))
# clicks
for tt in (13.55,20.45,22.45,27.85): add(click(.55),tt)
# typing
def typing(t0,t1,cps,g=.1):
    k=0; tt=t0
    while tt<t1:
        add(tick(g*(0.7+0.6*((k*37)%10)/10)),tt,pan=((k*13)%7-3)/10); k+=1; tt+=1/cps*(0.8+0.4*((k*53)%10)/10)
typing(32.6,34.2,17); typing(40.3,42.1,24); typing(47.7,48.9,26); typing(49.6,49.9,20); typing(50.1,50.4,14)
typing(11.1,11.8,28,.06)
# sends
for tt in (34.45,42.2): add(whoosh(.35,.18),tt)
# checkbox pops
for i in range(6): add(pluck(mtof(76+[0,2,4,7,9,12][i]),.25,.10),24.9+i*.16)
# success chime
for i,m in enumerate([72,76,79,84]): add(pluck(mtof(m),1.4,.16),28.4+i*.09,pan=(i-1.5)/3)
# tool done dings
for tt in (36.3,43.8,51.4): add(pluck(mtof(88),.5,.10),tt); add(pluck(mtof(83),.5,.07),tt+.07)
# safety hits
add(impact(.4),52.7); add(impact(.55),53.4)
for i in range(4): add(pluck(mtof(69+[0,3,7,12][i]),.4,.08),54.1+i*.18)
# reverb (simple multi-tap)
def verb(x):
    y=x.copy()
    for d,g in ((.031,.35),(.047,.3),(.083,.25),(.127,.2),(.211,.15),(.337,.1)):
        k=int(d*SR); y[k:]+=x[:-k]*g
    return y
L=verb(L); R=verb(R)
m=np.max(np.abs(np.concatenate([L,R]))); 
out=np.stack([L,R],1)/m*0.89
fade=np.clip((D-np.arange(N)/SR)/1.2,0,1); out*=fade[:,None]
out=np.tanh(out*1.2)/np.tanh(1.2)
w=wave.open('music.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((out*32000).astype(np.int16).tobytes()); w.close(); print('ok')
