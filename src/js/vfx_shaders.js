(function() {
  if (window.__dcVfxShaders && window.__dcVfxShaders.version === 1) {
    return 'already-mounted';
  }

  const PRESETS = [
    { id: 'fairy',   label: 'Fairy Dust',      styleId: 0 },
    { id: 'sakura',  label: 'Sakura Petals',   styleId: 1 },
    { id: 'ember',   label: 'Ember Ash',       styleId: 2 },
    { id: 'glitch',  label: 'Cyber Glitch',    styleId: 3 },
    { id: 'vortex',  label: 'Void Vortex',     styleId: 4 },
    { id: 'shatter', label: 'Crystal Shatter', styleId: 5 },
    { id: 'random',  label: 'Random',          styleId: -1 }
  ];

  const PALETTES = [
    [[175,188,255],[238,178,255],[135,242,255],[255,232,162],[255,180,218],[255,255,255]],
    [[255,209,224],[255,182,206],[255,234,242],[248,152,186],[255,245,250],[255,196,214]],
    [[255,245,195],[255,175,55],[255,92,24],[225,38,18],[255,210,96],[255,128,42]],
    [[0,245,255],[255,32,168],[130,80,255],[60,255,190],[255,255,255],[0,175,255]],
    [[155,85,255],[95,230,255],[215,110,255],[85,120,255],[245,240,255],[190,140,255]],
    [[210,248,255],[150,224,255],[255,255,255],[195,212,255],[110,200,255],[235,252,255]]
  ];

  // --- GLSL ES 3.00 Multi-Shader Dissolve Pipeline (6 simultaneous GPU styles via packed aKind) ---
  const VERT_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aStartPos;
layout(location=1) in vec3 aColor;
layout(location=2) in vec3 aMagicColor;
layout(location=3) in vec4 aParams;
layout(location=4) in float aKind;
layout(location=5) in vec3 aVel;
uniform vec2 uResolution;
uniform float uDpr;
uniform float uTime;
out float vProgress;
out vec3 vColor;
out vec3 vMagicColor;
out float vSeed;
out float vKind;
out float vStyle;
out float vTime;
out float vPointPx;
out float vExtra;
float ss(float a,float b,float x){return smoothstep(a,b,x);}
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
 const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
 vec2 i=floor(v+dot(v,C.yy)),x0=v-i+dot(i,C.xx),i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
 vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
 vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
 vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
 m=m*m; m=m*m;
 vec3 x=2.0*fract(p*C.www)-1.0,h=abs(x)-0.5,a0=x-floor(x+0.5);
 m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
 vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
 return 130.0*dot(m,g);
}
vec2 curlWind(vec2 p){
 const float e=0.04;
 return vec2(snoise(p+vec2(0.0,e))-snoise(p-vec2(0.0,e)),-(snoise(p+vec2(e,0.0))-snoise(p-vec2(e,0.0))))/(2.0*e);
}
void main(){
 float rk=floor(aKind+0.5),sid=floor(rk*0.25+0.001),kind=rk-sid*4.0;
 float life=max(aParams.y,0.001),seed=aParams.w,age=uTime-aParams.x,prog=age/life;
 if(prog>=1.0||(kind>0.5&&age<0.0)){
  gl_Position=vec4(2.0,2.0,0.0,1.0); gl_PointSize=0.0;
  vProgress=1.0; vColor=aColor; vMagicColor=aMagicColor; vSeed=seed;
  vKind=kind; vStyle=sid; vTime=uTime; vPointPx=1.0; vExtra=0.0; return;
 }
 vec2 pos=aStartPos;
 float sc=1.0,bm=(kind<0.5)?1.65:1.0,ex=0.0,t=clamp(prog,0.0,1.0);
 if(sid<0.5){
  ex=seed*6.283185+uTime*mix(-3.0,3.0,fract(seed*17.13));
  if(age>0.0){
   float imp=step(25.0,aVel.z),dr=mix(1.45,2.85,imp),lf=(age*age)/(age+0.16);
   vec2 fp=aStartPos*0.0055+vec2(uTime*0.28,-uTime*0.42);
   vec2 cw=curlWind(fp)+0.42*curlWind(fp*2.1+vec2(seed*1.6,-seed*1.2));
   vec2 hm=vec2(sin(age*(3.6+seed*3.2)+seed*6.28318),cos(age*(2.8+seed*2.4)+seed*4.71239))*mix(8.5,1.5,imp)*ss(0.0,0.4,t);
   pos+=aVel.xy*((1.0-exp(-dr*age))/dr)+vec2(0.0,0.5*aVel.z*age*age)+cw*mix(20.0+seed*15.0,4.5,imp)*lf+hm;
   sc=(kind<0.5)?mix(1.0,1.28,ss(0.0,0.22,t))*mix(1.0,0.54,ss(0.22,1.0,t)):((kind<1.5)?ss(0.0,0.12,t)*(1.0-0.36*t):mix(0.72,1.32,ss(0.0,0.85,t)));
  }
 }else if(sid<1.5){
  ex=seed*6.283185+max(age,0.0)*(3.2+seed*3.4);
  if(age>0.0){
   float dr=0.92,lf=(age*age)/(age+0.20);
   vec2 fp=aStartPos*0.0038+vec2(uTime*0.36,uTime*0.14);
   vec2 flt=vec2(sin(age*(3.8+seed*2.8)+seed*6.283185)*14.0,cos(age*(2.5+seed*2.1)+seed*4.1)*11.0);
   pos+=aVel.xy*((1.0-exp(-dr*age))/dr)+curlWind(fp)*(18.0+seed*16.0)*lf+(flt+vec2(0.0,0.5*aVel.z*age*age))*ss(0.0,0.3,t);
   sc=(kind<0.5)?mix(1.0,2.35,ss(0.02,0.32,t))*mix(1.0,0.62,ss(0.55,1.0,t)):((kind<1.5)?ss(0.0,0.14,t)*(1.0-0.25*t):mix(0.65,1.25,ss(0.0,0.65,t)));
  }
 }else if(sid<2.5){
  ex=seed*6.283185;
  if(age>0.0){
   float ash=step(0.54,fract(seed*9.73)),dr=mix(1.25,1.95,ash),lf=(age*age)/(age+0.14);
   vec2 fp=aStartPos*0.0072+vec2(uTime*0.22,uTime*1.15);
   vec2 tb=curlWind(fp)+0.5*curlWind(fp*2.3+vec2(seed*3.1,-uTime*0.6));
   float jx=sin(age*(9.0+seed*8.0)+seed*21.0)*mix(5.5,10.5,ash)*ss(0.0,0.35,t);
   pos+=aVel.xy*((1.0-exp(-dr*age))/dr)+vec2(jx,0.5*aVel.z*age*age)+tb*mix(16.0,26.0,ash)*lf;
   vec2 av=aVel.xy*exp(-dr*age)+vec2(0.0,aVel.z*age)+tb*16.0;
   vec2 sv=(length(av)>0.001)?av:vec2(0.0,-1.0);
   ex=(kind<0.5)?(seed*6.283185+age*mix(-4.5,4.5,fract(seed*13.3))):atan(sv.y,sv.x);
   sc=(kind<0.5)?mix(1.0,1.35,ss(0.0,0.10,t))*mix(1.0,0.48,ss(0.16,1.0,t)):((kind<1.5)?ss(0.0,0.08,t)*mix(1.15,0.38,ss(0.20,1.0,t)):mix(0.60,1.45,ss(0.0,0.45,t))*(1.0-0.35*t));
  }
 }else if(sid<3.5){
  if(age>0.0){
   float qs=floor(age*18.0),qa=qs/18.0,qt=floor(uTime*18.0),bd=floor(aStartPos.y/6.0);
   float bn=fract(sin(bd*127.1+qt*311.7)*43758.5453)*2.0-1.0;
   float bo=step(0.42,fract(sin(bd*53.7+qt*19.3)*19381.7));
   float tx=bn*(22.0+38.0*bo)*(1.0-ss(0.32,0.72,t));
   float mx=(fract(sin(seed*91.7+qs*17.3)*4375.5)*2.0-1.0)*14.0*ss(0.0,0.2,t),rt=max(0.0,qa-0.10);
   pos+=vec2(tx+mx+aVel.x*qa*0.45,aVel.y*rt+0.5*aVel.z*rt*rt);
   ex=clamp(0.35+0.65*bo+0.35*abs(bn),0.0,1.35);
   sc=(kind<0.5)?mix(1.0,1.42,ss(0.0,0.14,t))*mix(1.0,0.62,ss(0.55,1.0,t)):((kind<1.5)?ss(0.0,0.06,t)*(1.0-0.32*t):ss(0.0,0.10,t)*(1.0-0.25*t));
  }
 }else if(sid<4.5){
  ex=seed*6.283185;
  if(age>0.0){
   vec2 ctr=aVel.xy,rel=aStartPos-ctr; float r0=length(rel);
   if(kind<1.5){
    vec2 sr=(r0>0.001)?rel:vec2(cos(seed*6.283185),sin(seed*6.283185));
    float pull=pow(max(t,0.0001),1.55),r=r0*exp(-3.45*pull)*(1.0-ss(0.78,0.97,t));
    float th=atan(sr.y,sr.x)+aVel.z*(age*0.85+1.85*pull*pull);
    vec2 rd=vec2(cos(th),sin(th)),td=vec2(-sin(th),cos(th));
    pos=ctr+rd*r;
    vec2 vv=rd*(-3.45*max(r,1.0))+td*(aVel.z*max(r,4.0)),sv=(length(vv)>0.001)?vv:td;
    ex=atan(sv.y,sv.x);
    sc=(kind<0.5)?mix(1.0,1.95,ss(0.08,0.55,t))*mix(1.0,0.45,ss(0.75,1.0,t)):ss(0.0,0.12,t)*(1.0-0.55*ss(0.65,1.0,t));
   }else{
    pos=ctr; ex=uTime*4.0+seed*6.283185;
    float fd=(t-0.62)*8.5;
    sc=mix(0.25,1.15,ss(0.0,0.48,t))*(1.0-ss(0.62,0.98,t))+exp(-(fd*fd))*0.65;
   }
  }
 }else{
  ex=seed*6.283185+max(age,0.0)*mix(-10.5,10.5,fract(seed*19.37));
  if(age>0.0){
   if(kind<1.5){
    float dr=0.78;
    pos+=aVel.xy*((1.0-exp(-dr*age))/dr)+vec2(0.0,0.5*aVel.z*age*age);
    sc=(kind<0.5)?mix(1.0,1.55,ss(0.0,0.14,t))*mix(1.0,0.58,ss(0.58,1.0,t)):ss(0.0,0.05,t)*(1.0-0.30*ss(0.55,1.0,t));
   }else{
    pos+=aVel.xy*age*0.15;
    sc=mix(0.35,1.35,ss(0.0,0.24,t))*(1.0-0.45*t);
   }
  }
 }
 vec2 ndc=(pos/max(uResolution,vec2(1.0)))*2.0-1.0;
 gl_Position=vec4(ndc.x,-ndc.y,0.0,1.0);
 float ptPx=clamp(aParams.z*bm*sc*uDpr,1.0,96.0);
 gl_PointSize=ptPx;
 vProgress=prog; vColor=aColor; vMagicColor=aMagicColor; vSeed=seed;
 vKind=kind; vStyle=sid; vTime=uTime; vPointPx=ptPx; vExtra=ex;
}`;

  const FRAG_SRC = `#version 300 es
precision highp float;
in float vProgress;
in vec3 vColor;
in vec3 vMagicColor;
in float vSeed;
in float vKind;
in float vStyle;
in float vTime;
in float vPointPx;
in float vExtra;
out vec4 fragColor;
float ss(float a,float b,float x){return smoothstep(a,b,x);}
float sdBox(vec2 p,vec2 b,float r){
 vec2 q=abs(p)-max(b-vec2(r),vec2(0.001));
 return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;
}
vec2 rot2(vec2 p,float a){float c=cos(a),s=sin(a);return vec2(p.x*c-p.y*s,p.x*s+p.y*c);}
void main(){
 if(vProgress>=1.0) discard;
 vec2 p=gl_PointCoord-0.5;
 float dist=length(p),t=clamp(vProgress,0.0,1.0),omt=max(1.0-t,0.0001);
 float aa=clamp(0.80/max(vPointPx,1.0),0.022,0.14),a=0.0;
 vec3 col=vec3(0.0);

 if(vStyle<0.5){
  if(dist>0.5) discard;
  if(vKind<0.5){
   float wf=vProgress*9.5,fl=exp(-(wf*wf)),mp=ss(0.0,0.56,t);
   float hs=mix(0.305,0.145,ss(0.0,0.92,t)),cn=mix(0.02,hs,ss(0.02,0.45,t));
   float cm=1.0-ss(-aa,aa,sdBox(p,vec2(hs),cn));
   float tw=0.5+0.5*sin(vTime*(13.0+vSeed*11.0)+vSeed*41.23),tw2=tw*tw,sp=(tw2*tw2)*ss(0.06,0.40,t);
   vec3 ir=0.58+0.42*cos(vTime*4.5+vSeed*18.85+t*5.0+vec3(0.0,2.094,4.188));
   vec3 mt=mix(vMagicColor,ir,0.32*ss(0.15,0.85,t));
   col=mix(mix(mix(vColor,mt,mp),mix(mt,vec3(1.0),0.55),fl*0.52),vec3(1.0),sp*0.68);
   float fo=pow(omt,1.32),hl=exp(-dist*dist*mix(26.0,13.0,mp))*(1.0-ss(0.32,0.5,dist));
   a=clamp(cm*fo*mix(1.0,0.68+0.32*tw,ss(0.0,0.25,t))*0.96+hl*(fl*0.40+ss(0.0,0.28,t)*(0.42+0.48*sp))*fo,0.0,1.0);
  }else if(vKind<1.5){
   vec2 rp=rot2(p,vExtra),u=abs(rp)*2.0;
   float sm=1.0-ss(0.60,0.94,pow(u.x+1e-4,0.52)+pow(u.y+1e-4,0.52)),em=1.0-ss(0.34,0.5,dist),r2=dot(rp,rp);
   float hf=(0.012/(abs(rp.x*rp.y)+0.012))*exp(-r2*18.0)*em;
   float env=ss(0.0,0.14,t)*pow(omt,1.45)*(0.62+0.38*sin(vTime*(15.0+vSeed*10.0)+vSeed*31.4159));
   col=mix(mix(vColor,vMagicColor,0.35+0.45*t),vec3(1.0),clamp(exp(-r2*52.0)*0.85+sm*0.38,0.0,1.0));
   a=clamp(clamp(sm*0.95+hf*0.32+exp(-r2*11.5)*em*0.45,0.0,1.0)*env,0.0,1.0);
  }else{
   float r=dist*2.0;
   col=mix(mix(vColor,vMagicColor,t*0.65),vec3(1.0),exp(-r*r*14.0)*0.32);
   a=clamp(exp(-r*r*4.5)*(1.0-ss(0.72,1.0,r))*ss(0.0,0.22,t)*pow(omt,1.55)*0.62,0.0,1.0);
  }
 }else if(vStyle<1.5){
  if(dist>0.5) discard;
  if(vKind<1.5){
   float rc=cos(vExtra),rs=mix(0.40,1.0,abs(rc));
   float ang=vSeed*6.283185+vTime*mix(-2.0,2.0,fract(vSeed*13.7))+sin(vTime*2.4+vSeed*9.0)*0.45;
   vec2 rp=rot2(p,ang),fp=vec2(rp.x/rs,rp.y),q=vec2(abs(fp.x),fp.y);
   float ys=q.y+0.115*max(0.0,1.0-q.x*7.2)*ss(0.0,0.26,q.y);
   float tp=mix(0.56,1.18,clamp((ys+0.34)/0.68,0.0,1.0));
   float sdP=(length(vec2(q.x/max(tp,0.25),ys*0.88))-0.275)*rs;
   float blush=1.0-ss(-0.30,0.22,fp.y),vein=exp(-fp.x*fp.x*150.0)*ss(-0.28,0.14,fp.y)*(1.0-ss(0.14,0.28,fp.y));
   vec3 pc=mix(mix(mix(vMagicColor,vec3(1.0,0.95,0.98),0.24+0.34*(0.35+0.65*abs(rc))),vec3(0.98,0.54,0.72),blush*0.34),vec3(1.0),vein*0.24);
   if(vKind<0.5){
    float wf=vProgress*9.0,fl=exp(-(wf*wf)),mp=ss(0.02,0.32,t);
    float m=1.0-ss(-aa,aa,mix(sdBox(p,vec2(0.305),0.02),sdP,mp));
    col=mix(mix(vColor,pc,ss(0.0,0.42,t)),vec3(1.0,0.94,0.98),fl*0.46);
    float hl=exp(-dist*dist*16.0)*(1.0-ss(0.32,0.5,dist))*(fl*0.36+0.16*mp);
    a=clamp((m*0.96+hl)*pow(omt,1.24),0.0,1.0);
   }else{
    col=pc;
    a=clamp(((1.0-ss(-aa,aa,sdP))*0.94+exp(-dist*dist*14.0)*(1.0-ss(0.32,0.5,dist))*0.20)*ss(0.0,0.14,t)*pow(omt,1.32),0.0,1.0);
   }
  }else{
   float r=dist*2.0,tw=0.65+0.35*sin(vTime*11.0+vSeed*27.0);
   col=mix(vMagicColor,vec3(1.0,0.96,0.99),exp(-r*r*14.0)*0.55);
   a=clamp(exp(-r*r*5.2)*(1.0-ss(0.70,1.0,r))*ss(0.0,0.20,t)*pow(omt,1.45)*0.68*tw,0.0,1.0);
  }
 }else if(vStyle<2.5){
  if(dist>0.5) discard;
  if(vKind<0.5){
   float ash=step(0.54,fract(vSeed*9.73)),mp=ss(0.02,0.28,t);
   vec2 rp=rot2(p,vExtra),ap=vec2(rp.x*1.45,rp.y*0.95);
   float sd=mix(sdBox(p,vec2(0.305),0.02),mix(dist-mix(0.25,0.12,t),(abs(ap.x)+abs(ap.y))-0.30,ash),mp);
   float m=1.0-ss(-aa,aa,sd),ig=(vProgress-0.05)*9.5,ign=exp(-(ig*ig));
   float cool=ss(0.14,0.78,t),flk=0.62+0.38*sin(vTime*(20.0+vSeed*16.0)+vSeed*47.0);
   vec3 mol=vec3(1.0,0.44,0.06),crm=vec3(0.82,0.12,0.02),ac=vec3(0.18,0.15,0.15);
   col=mix(vColor,mix(mix(mol,crm,cool),mix(crm,ac,ss(0.22,0.62,t)),ash),ss(0.0,0.26,t));
   col=mix(col,vec3(1.0,0.96,0.76),clamp(ign*0.92+(1.0-ash)*(1.0-cool)*flk*0.48,0.0,1.0));
   col=mix(col,mol,ash*ss(-0.08,0.0,sd)*(1.0-ss(0.0,aa,sd))*(1.0-ss(0.20,0.68,t))*0.88);
   float fo=pow(omt,mix(1.36,1.16,ash)),hl=exp(-dist*dist*16.0)*(1.0-ss(0.32,0.5,dist));
   a=clamp(m*fo*0.96+hl*(ign*0.72+(1.0-ash)*(1.0-cool*0.65)*0.56*flk)*fo,0.0,1.0);
  }else if(vKind<1.5){
   vec2 rp=rot2(p,-vExtra);
   float ds=length(vec2(rp.x*0.62,rp.y*2.35)),c=exp(-ds*ds*26.0);
   float flk=0.58+0.42*sin(vTime*(24.0+vSeed*18.0)+vSeed*33.0);
   col=mix(vec3(1.0,0.36,0.04),vec3(1.0,0.95,0.72),clamp(c*1.15,0.0,1.0));
   a=clamp((c*0.96+exp(-ds*ds*7.0)*(1.0-ss(0.32,0.5,dist))*0.58)*ss(0.0,0.08,t)*pow(omt,1.38)*flk,0.0,1.0);
  }else{
   float r=dist*2.0;
   col=mix(vec3(1.0,0.42,0.06),vec3(0.42,0.10,0.06),t);
   a=clamp(exp(-r*r*4.2)*(1.0-ss(0.70,1.0,r))*ss(0.0,0.14,t)*pow(omt,1.65)*0.52,0.0,1.0);
  }
 }else if(vStyle<3.5){
  float qt=floor(vTime*18.0);
  if(vKind<0.5){
   if(vProgress<=0.0){
    col=vColor; a=1.0-ss(-aa,aa,sdBox(p,vec2(0.305),0.01));
   }else{
    float sp=mix(0.025,0.145,ss(0.0,0.30,t))*clamp(vExtra,0.3,1.35);
    vec2 hs=vec2(mix(0.305,0.34,ss(0.0,0.25,t)),mix(0.305,0.23,ss(0.10,0.75,t)));
    float mR=1.0-ss(-aa,aa,sdBox(p+vec2(sp,0.0),hs,0.01)),mG=1.0-ss(-aa,aa,sdBox(p,hs,0.01)),mB=1.0-ss(-aa,aa,sdBox(p-vec2(sp,0.0),hs,0.01));
    float mm=max(mR,max(mG,mB));
    vec3 ne=mix(vColor,vMagicColor,ss(0.08,0.62,t));
    float sc=0.80+0.20*step(0.45,fract(gl_PointCoord.y*3.0+qt*0.25));
    float blk=mix(1.0,step(0.24,fract(sin(qt*19.7+vSeed*113.1)*4375.3)),ss(0.48,0.86,t));
    col=(vec3(mR*max(ne.r,0.88),mG*ne.g,mB*max(ne.b,0.92))/max(mm,0.001))*sc;
    a=clamp(mm*pow(omt,1.15)*blk*0.96,0.0,1.0);
   }
  }else if(vKind<1.5){
   float sp=0.11*clamp(vExtra,0.4,1.35); vec2 hs=vec2(0.36,0.10);
   float mR=1.0-ss(-aa,aa,sdBox(p+vec2(sp,0.0),hs,0.008)),mG=1.0-ss(-aa,aa,sdBox(p,hs,0.008)),mB=1.0-ss(-aa,aa,sdBox(p-vec2(sp,0.0),hs,0.008));
   float mm=max(mR,max(mG,mB)),blk=step(0.18,fract(sin(qt*29.3+vSeed*71.7)*2917.1));
   col=vec3(mR,mG*max(vMagicColor.g,0.72),mB)/max(mm,0.001);
   a=clamp(mm*ss(0.0,0.06,t)*pow(omt,1.25)*blk*0.92,0.0,1.0);
  }else{
   float cm=(1.0-ss(0.14-aa,0.14+aa,abs(p.x)))*(1.0-ss(0.44-aa,0.44+aa,abs(p.y)));
   col=mix(vMagicColor,vec3(1.0),ss(0.14,0.44,p.y)*0.78);
   a=clamp(cm*step(0.22,fract((p.y+0.5)*6.0))*ss(-0.44,0.35,p.y)*ss(0.0,0.10,t)*pow(omt,1.25)*0.90,0.0,1.0);
  }
 }else if(vStyle<4.5){
  if(dist>0.5) discard;
  if(vKind<0.5){
   float mp=ss(0.04,0.45,t); vec2 rp=rot2(p,-vExtra),hs=vec2(rp.x*1.4,rp.y*3.5);
   float sd=mix(sdBox(p,vec2(0.305),0.02),length(vec2(rp.x*0.62,rp.y*2.55))-0.21,mp),hf=ss(0.62,0.93,t);
   col=mix(mix(vColor,vMagicColor,ss(0.08,0.56,t)),vec3(0.88,0.97,1.0),hf*0.82);
   a=clamp(((1.0-ss(-aa,aa,sd))*0.94+exp(-dot(hs,hs)*5.5)*(1.0-ss(0.32,0.5,dist))*(mp*0.65+hf*0.45))*(1.0-ss(0.86,1.0,t)),0.0,1.0);
  }else if(vKind<1.5){
   vec2 rp=rot2(p,-vExtra),hs=vec2(rp.x*0.72,rp.y*2.8);
   float d2=dot(hs,hs),c=exp(-d2*24.0);
   col=mix(vMagicColor,vec3(0.85,0.98,1.0),clamp(c*0.95+ss(0.6,0.92,t)*0.5,0.0,1.0));
   a=clamp((c*0.95+exp(-d2*6.5)*(1.0-ss(0.32,0.5,dist))*0.55)*ss(0.0,0.14,t)*(1.0-ss(0.84,1.0,t)),0.0,1.0);
  }else{
   float r=dist*2.0,em=1.0-ss(0.74,1.0,r),dr=(r-mix(0.48,0.15,ss(0.0,0.64,t)))*7.2;
   vec2 sp=rot2(p,vExtra),ssp=(length(sp)>0.001)?sp:vec2(1.0,0.0);
   float rays=0.68+0.32*sin(atan(ssp.y,ssp.x)*5.0+r*9.0);
   float vc=(1.0-ss(0.16,0.32,r))*ss(0.0,0.18,t)*(1.0-ss(0.56,0.72,t));
   float fdt=(t-0.64)*7.2,fs=exp(-r*r*14.0)*exp(-(fdt*fdt)),sd2=(r-ss(0.58,0.92,t)*0.85)*9.0;
   float sh=exp(-(sd2*sd2))*ss(0.56,0.66,t)*(1.0-ss(0.75,0.98,t))*em;
   float ga=clamp((exp(-(dr*dr))*em*rays*0.82*(1.0-ss(0.68,0.95,t))+fs*0.95+sh*0.70)*ss(0.0,0.14,t),0.0,1.0);
   a=clamp(max(vc*0.84,ga),0.0,1.0);
   col=mix(vec3(0.03,0.01,0.08),mix(vMagicColor,vec3(0.85,0.98,1.0),clamp(fs*1.1+sh*0.65,0.0,1.0)),clamp(ga/max(a,0.001),0.0,1.0));
  }
 }else{
  if(dist>0.5) discard;
  if(vKind<1.5){
   vec2 rp=rot2(p,vExtra);
   vec2 sp=vec2(rp.x*mix(1.30,2.20,fract(vSeed*11.73))+rp.y*mix(-0.26,0.26,fract(vSeed*23.17)),rp.y);
   float sdS=max((abs(sp.x)+abs(sp.y))-0.35,sp.x*0.52-sp.y*0.34-0.23);
   float fac=ss(-0.04,0.04,sp.x*0.75+sp.y*0.45),glt=pow(max(abs(cos(vExtra*1.5+vSeed*5.2)),0.0001),6.0);
   if(vKind<0.5){
    float mp=ss(0.0,0.22,t),sd=mix(sdBox(p,vec2(0.305),0.02),sdS,mp);
    float rim=ss(-0.09,0.0,sd)*(1.0-ss(0.0,aa,sd)),cf=(vProgress-0.02)*11.0,cfl=exp(-(cf*cf));
    col=mix(mix(vColor,mix(vColor*0.84,mix(vColor,vMagicColor,0.54),fac),mp),vec3(0.94,0.99,1.0),clamp(rim*0.76*mp+glt*0.78*mp+cfl*0.65,0.0,1.0));
    a=clamp(((1.0-ss(-aa,aa,sd))*0.95+exp(-dist*dist*20.0)*(1.0-ss(0.30,0.5,dist))*(glt*0.55*mp+cfl*0.48))*pow(omt,1.24),0.0,1.0);
   }else{
    float rim=ss(-0.10,0.0,sdS)*(1.0-ss(0.0,aa,sdS));
    col=mix(mix(vMagicColor*0.72,mix(vMagicColor,vec3(1.0),0.58),fac),vec3(1.0),clamp(rim*0.86+glt*0.85,0.0,1.0));
    a=clamp(((1.0-ss(-aa,aa,sdS))*0.86+exp(-dist*dist*16.0)*(1.0-ss(0.32,0.5,dist))*(0.28+0.52*glt))*ss(0.0,0.05,t)*pow(omt,1.32),0.0,1.0);
   }
  }else{
   float r=dist*2.0,em=1.0-ss(0.72,1.0,r);
   vec2 sp=rot2(p,vSeed*6.283185),ssp=(length(sp)>0.001)?sp:vec2(1.0,0.0);
   float spk=pow(max(abs(cos(atan(ssp.y,ssp.x)*3.0)),0.0001),6.0),c=exp(-r*r*14.0);
   col=mix(vMagicColor,vec3(1.0),clamp(c*0.90,0.0,1.0));
   a=clamp((c+spk*exp(-r*r*4.5)*0.72)*em*ss(0.0,0.08,t)*pow(omt,1.65)*0.88,0.0,1.0);
  }
 }
 if(a<0.004) discard;
 fragColor=vec4(col*a,a);
}`;

  window.__dcVfxShaders = {
    version: 1,
    PRESETS,
    PALETTES,
    VERT_SRC,
    FRAG_SRC,
    destroy() { delete window.__dcVfxShaders; }
  };

  return 'mounted';
})();
