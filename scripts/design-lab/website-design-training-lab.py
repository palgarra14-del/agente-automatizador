#!/usr/bin/env python3
import json, os, shutil, subprocess, sys, time, textwrap
from pathlib import Path
from datetime import datetime, timezone

HOME = Path.home()
REPO = Path(os.environ.get("AGENT_REPO", "/home/pablo/projects/agente-automatizador")).resolve()
STATE = Path(os.environ.get("DESIGN_LAB_STATE_DIR", str(HOME/".local/state/engineering-orchestrator/design-lab"))).resolve()
RUNS = STATE / "runs"
LOCK = STATE / "active.lock"
PLAYBOOK = STATE / "playbook.md"
PLAYBOOK_SEED = REPO / "docs/design-training-playbook.md"
HISTORY = STATE / "history.jsonl"
MASTERY = STATE / "mastery.json"
CODEX = str(REPO / "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")
CHROME = os.environ.get("BROWSER_QA_CHROME_PATH", "/usr/bin/google-chrome")
PORT = 4187
THRESHOLD = 9.2
CATEGORY_FLOOR = 8.8
STREAK_NEEDED = 6
BUILD_LIMIT_SECONDS = 600
MAX_FIX_PASSES = 2
SYNTHETIC_CONTACT = {"phone": "+34000000000", "email": "demo@example.invalid"}
LOCAL_QA = (REPO / "scripts/design-lab/local-qa.mjs") if (REPO / "scripts/design-lab/local-qa.mjs").exists() else (STATE / "local-qa.mjs")
SCORE_WEIGHTS = {"identity":0.15,"hierarchy":0.15,"typography":0.12,"composition":0.15,"authenticity":0.10,"conversion":0.13,"mobile":0.10,"polish":0.10}

BRIEFS = [
  {
    "slug": "salon-color-premium",
    "business": "Luma Studio",
    "category": "Peluquería femenina / color",
    "brief": "Salón urbano especializado en color, corte y cuidado capilar. Marca contemporánea, cálida y editorial. Objetivo: llamada para reservar. Sin precios, premios, reseñas ni fotografías reales; no inventarlos."
  },
  {
    "slug": "barberia-contemporanea",
    "business": "Norte Barber Club",
    "category": "Barbería masculina contemporánea",
    "brief": "Barbería de corte, barba y grooming. Personalidad urbana, cuidada, de oficio y sin clichés vintage. Objetivo: llamada para reservar. Sin hechos no suministrados."
  },
  {
    "slug": "reformas-interiores",
    "business": "Forma Reforma",
    "category": "Reformas integrales",
    "brief": "Empresa local de reformas de viviendas, cocinas y baños. Posicionamiento fiable y contemporáneo, evitando la plantilla típica de gremios. Objetivo: solicitar visita o llamada. No inventar cifras, clientes, garantías ni años."
  },
  {
    "slug": "pintura-decoracion",
    "business": "Materia Pintura",
    "category": "Pintura y decoración",
    "brief": "Estudio local de pintura interior y acabados decorativos. Debe comunicar materialidad, cuidado y transformación visual. Objetivo: pedir presupuesto. Sin proyectos o testimonios inventados."
  },
  {
    "slug": "fontaneria-premium",
    "business": "Caudal Servicios",
    "category": "Fontanería local",
    "brief": "Servicio de fontanería para vivienda y pequeños negocios con imagen moderna, clara y profesional. No afirmar urgencias 24h. Objetivo: llamada/contacto. Evitar iconos y tarjetas genéricas de oficio."
  },
  {
    "slug": "estudio-arquitectura",
    "business": "Umbral Arquitectura",
    "category": "Arquitectura e interiorismo",
    "brief": "Estudio pequeño de arquitectura residencial e interiorismo. Dirección premium/editorial, sobria y espacial. Objetivo: solicitar una primera conversación. Sin portfolio real disponible: no inventarlo."
  },
  {
    "slug": "cafeteria-especialidad",
    "business": "Tostado Local",
    "category": "Cafetería de especialidad",
    "brief": "Cafetería local con personalidad contemporánea y cálida. Priorizar atmósfera, producto y visita al local sin usar fotos falsas de personas o del espacio. Objetivo: visita/contacto."
  },
  {
    "slug": "clinica-dental",
    "business": "Clara Dental",
    "category": "Clínica dental local",
    "brief": "Clínica dental con posicionamiento humano, preciso y sereno. Objetivo: pedir cita por teléfono. Evitar estética médica genérica, stock de sonrisas, claims clínicos no verificados y cifras inventadas."
  }
]

HOLDOUT_BRIEFS = [
  {
    "slug": "holdout-fisioterapia",
    "business": "Movimiento Fisio",
    "category": "Centro de fisioterapia",
    "brief": "Centro local de fisioterapia con posicionamiento humano, técnico y contemporáneo. Objetivo: pedir cita. No inventar resultados clínicos, especialistas, tratamientos concretos, reseñas, cifras ni acreditaciones."
  },
  {
    "slug": "holdout-carpinteria",
    "business": "Veta Taller",
    "category": "Carpintería a medida",
    "brief": "Taller local de carpintería y mobiliario a medida. Debe transmitir oficio, materialidad y detalle sin inventar proyectos, clientes, maderas concretas, años de experiencia ni certificaciones. Objetivo: solicitar una conversación."
  },
  {
    "slug": "holdout-academia",
    "business": "Punto Idiomas",
    "category": "Academia local de idiomas",
    "brief": "Academia de idiomas para jóvenes y adultos con imagen clara, viva y profesional. Objetivo: solicitar información. No inventar niveles, profesores, aprobados, precios, titulaciones oficiales ni testimonios."
  }
]

BRIEF_FOCUS = {
  "salon-color-premium": ["identity","typography","composition","mobile"],
  "barberia-contemporanea": ["identity","typography","composition","polish"],
  "reformas-interiores": ["authenticity","conversion","mobile","hierarchy"],
  "pintura-decoracion": ["identity","composition","authenticity","polish"],
  "fontaneria-premium": ["hierarchy","conversion","mobile","polish"],
  "estudio-arquitectura": ["typography","composition","identity","polish"],
  "cafeteria-especialidad": ["identity","composition","authenticity","mobile"],
  "clinica-dental": ["hierarchy","typography","conversion","authenticity","polish"]
}

BASE_PLAYBOOK = """# Website Design Training Playbook

## Standard
- Start from one explicit creative concept and one intended emotion; do not assemble a page from default components.
- First viewport: one focal hierarchy, clear positioning and one obvious next action.
- Typography is architecture: strong display/body relationship, disciplined measure, optical alignment and spacing rhythm.
- Use a deliberate grid and vary section rhythm; avoid identical stacked bands.
- Prefer one or two signature visual ideas repeated coherently over many unrelated effects.
- Mobile is a recomposition, not a scaled desktop. Preserve hierarchy, crop intent, CTA access and tap targets.
- Motion must explain hierarchy, state, cause/effect or brand character and respect reduced motion.
- Prefer authentic supplied work, product, people and spaces. When unavailable, use honest typography/abstract art rather than fake documentary images.
- Avoid card soup, arbitrary rounded rectangles, excessive pills, generic gradient blobs, decorative glassmorphism, repeated icon-text triples, meaningless marquees and stock-template hero compositions.
- Conversion remains obvious without turning every section into a CTA.
- Never invent facts, prices, reviews, awards, clients, guarantees, years, claims or imagery presented as real.
- Aim for agency-level polish while keeping performance, accessibility, semantic HTML and responsiveness.

## Learned lessons
- None yet.
"""

REVIEW_SCHEMA = {
  "type": "object",
  "additionalProperties": False,
  "required": ["totalScore","categoryScores","strengths","issues","fixBrief","transferableLessons","verdict"],
  "properties": {
    "totalScore": {"type":"number","minimum":0,"maximum":10},
    "categoryScores": {
      "type":"object",
      "additionalProperties": False,
      "required":["identity","hierarchy","typography","composition","authenticity","conversion","mobile","polish"],
      "properties": {k:{"type":"number","minimum":0,"maximum":10} for k in ["identity","hierarchy","typography","composition","authenticity","conversion","mobile","polish"]}
    },
    "strengths":{"type":"array","items":{"type":"string"},"maxItems":8},
    "issues":{"type":"array","items":{"type":"string"},"maxItems":10},
    "fixBrief":{"type":"array","items":{"type":"string"},"maxItems":8},
    "transferableLessons":{"type":"array","items":{"type":"string"},"maxItems":4},
    "verdict":{"type":"string","enum":["PASS","IMPROVE"]}
  }
}

def now():
    return datetime.now(timezone.utc).isoformat()

def run(cmd, cwd=None, timeout=None, check=True, stdout=None, stderr=None, input=None):
    return subprocess.run(cmd, cwd=cwd, timeout=timeout, check=check, text=True, stdout=stdout, stderr=stderr, input=input)

def ensure_state():
    STATE.mkdir(parents=True, exist_ok=True)
    RUNS.mkdir(parents=True, exist_ok=True)
    if not PLAYBOOK.exists():
        if PLAYBOOK_SEED.exists(): shutil.copy2(PLAYBOOK_SEED, PLAYBOOK)
        else: PLAYBOOK.write_text(BASE_PLAYBOOK, encoding="utf-8")
    schema = STATE / "review-schema.json"
    schema.write_text(json.dumps(REVIEW_SCHEMA, ensure_ascii=False, indent=2), encoding="utf-8")

def acquire_lock():
    import fcntl
    f = open(LOCK, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("design_lab_skip=already_running")
        sys.exit(0)
    f.write(str(os.getpid()))
    f.flush()
    return f

def history():
    if not HISTORY.exists(): return []
    out=[]
    for line in HISTORY.read_text(encoding="utf-8").splitlines():
        try: out.append(json.loads(line))
        except Exception: pass
    return out

def completed_history():
    return [entry for entry in history() if isinstance(entry.get("categoryScores"),dict)]

def concept_tokens(value):
    import re
    return {token for token in re.findall(r"[a-z0-9áéíóúüñ]+", str(value).lower()) if len(token) >= 4}

def concept_similarity(left, right):
    left_tokens=concept_tokens(left)
    right_tokens=concept_tokens(right)
    if not left_tokens or not right_tokens: return 0.0
    union=left_tokens | right_tokens
    return len(left_tokens & right_tokens)/len(union) if union else 0.0

def concept_identity(intent):
    if not isinstance(intent,dict): return ""
    return " | ".join([str(intent.get("concept","")).strip(),str(intent.get("signatureVisualDevice","")).strip()]).strip(" |")

def _metric_number(value, default=None):
    return float(value) if isinstance(value,(int,float)) else default

def _viewport_layout_profile(view):
    metrics=view.get("designMetrics",{}) if isinstance(view,dict) else {}
    blocks=metrics.get("visualBlocks",[]) if isinstance(metrics.get("visualBlocks"),list) else []
    actions=metrics.get("actions",[]) if isinstance(metrics.get("actions"),list) else []
    typography=metrics.get("typography",{}) if isinstance(metrics.get("typography"),dict) else {}
    heights=[round(max(0.0,min(6.0,_metric_number(block.get("heightVh"),0.0))),2) for block in blocks[:10] if isinstance(block,dict)]
    widths=[round(max(0.0,min(1.5,_metric_number(block.get("widthVw"),0.0))),2) for block in blocks[:10] if isinstance(block,dict)]
    aligns=[str(block.get("textAlign",""))[:16] for block in blocks[:10] if isinstance(block,dict)]
    displays=[str(block.get("display",""))[:16] for block in blocks[:10] if isinstance(block,dict)]
    body_size=_metric_number(typography.get("bodyFontSizePx"))
    h1_size=_metric_number(typography.get("h1FontSizePx"))
    ratio=round(h1_size/body_size,2) if body_size and h1_size and body_size > 0 else None
    visible_actions=[action for action in actions if isinstance(action,dict) and isinstance(action.get("yVh"),(int,float))]
    first_action=min(visible_actions,key=lambda action:action["yVh"]) if visible_actions else {}
    return {
      "blockCount":len(blocks[:10]),
      "heights":heights,
      "widths":widths,
      "aligns":aligns,
      "displays":displays,
      "pageHeightVh":round(_metric_number(metrics.get("pageHeightVh"),0.0),2),
      "h1BodyRatio":ratio,
      "firstActionYVh":round(_metric_number(first_action.get("yVh"),99.0),2) if first_action else None,
      "firstActionWidthVw":round(_metric_number(first_action.get("widthVw"),0.0),2) if first_action else None
    }

def layout_profile_from_qa(qa):
    if not isinstance(qa,dict): return {}
    return {
      "desktop":_viewport_layout_profile(qa.get("desktop",{})),
      "mobile":_viewport_layout_profile(qa.get("mobile",{}))
    }

def _ratio_similarity(left,right):
    if not isinstance(left,(int,float)) or not isinstance(right,(int,float)): return 0.0
    scale=max(abs(left),abs(right),1.0)
    return max(0.0,1.0-abs(left-right)/scale)

def _numeric_sequence_similarity(left,right,divisor=2.0):
    if not isinstance(left,list) or not isinstance(right,list) or not left or not right: return 0.0
    length=max(len(left),len(right))
    overlap=min(len(left),len(right))
    distance=sum(min(1.0,abs(float(left[i])-float(right[i]))/divisor) for i in range(overlap))
    distance += length-overlap
    return max(0.0,1.0-distance/length)

def _categorical_sequence_similarity(left,right):
    if not isinstance(left,list) or not isinstance(right,list) or not left or not right: return 0.0
    length=max(len(left),len(right))
    overlap=min(len(left),len(right))
    matches=sum(1 for i in range(overlap) if left[i] == right[i])
    return matches/length

def _viewport_layout_similarity(left,right):
    if not isinstance(left,dict) or not isinstance(right,dict): return 0.0
    parts=[
      (0.12,_ratio_similarity(left.get("blockCount"),right.get("blockCount"))),
      (0.28,_numeric_sequence_similarity(left.get("heights"),right.get("heights"),2.0)),
      (0.10,_numeric_sequence_similarity(left.get("widths"),right.get("widths"),0.6)),
      (0.10,_categorical_sequence_similarity(left.get("aligns"),right.get("aligns"))),
      (0.10,_categorical_sequence_similarity(left.get("displays"),right.get("displays"))),
      (0.10,_ratio_similarity(left.get("pageHeightVh"),right.get("pageHeightVh"))),
      (0.08,_ratio_similarity(left.get("h1BodyRatio"),right.get("h1BodyRatio"))),
      (0.07,_ratio_similarity(left.get("firstActionYVh"),right.get("firstActionYVh"))),
      (0.05,_ratio_similarity(left.get("firstActionWidthVw"),right.get("firstActionWidthVw")))
    ]
    return sum(weight*score for weight,score in parts)

def layout_similarity(left,right):
    if not isinstance(left,dict) or not isinstance(right,dict): return 0.0
    desktop=_viewport_layout_similarity(left.get("desktop"),right.get("desktop"))
    mobile=_viewport_layout_similarity(left.get("mobile"),right.get("mobile"))
    return round(0.55*desktop+0.45*mobile,3)

def _phone_digits(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())

def _email_address(value):
    text=str(value or "").strip()
    if text.lower().startswith("mailto:"): text=text[7:]
    return text.split("?",1)[0].strip().lower()

def conversion_ergonomics_from_qa(qa, brief_data):
    contact=brief_data.get("syntheticContact",{}) if isinstance(brief_data,dict) else {}
    expected_phone=_phone_digits(contact.get("phone"))
    expected_email=_email_address(contact.get("email"))
    defects=[]
    observations=[]
    viewports={}
    if not expected_phone and not expected_email:
        return {"pass":False,"defects":["missing_conversion_reference"],"observations":[],"viewports":{}}

    def matches(action):
        if not isinstance(action,dict): return False
        recipient=action.get("recipient")
        if action.get("kind") == "phone" and expected_phone:
            return _phone_digits(recipient) == expected_phone
        if action.get("kind") == "email" and expected_email:
            return _email_address(recipient) == expected_email
        return False

    for label,min_height in (("mobile",44.0),("desktop",36.0)):
        view=qa.get(label,{}) if isinstance(qa,dict) else {}
        metrics=view.get("designMetrics",{}) if isinstance(view,dict) else {}
        viewport=metrics.get("viewport",{}) if isinstance(metrics,dict) else {}
        viewport_width=_metric_number(viewport.get("width"),390.0 if label=="mobile" else 1440.0)
        viewport_height=_metric_number(viewport.get("height"),844.0 if label=="mobile" else 900.0)
        actions=metrics.get("actions",[]) if isinstance(metrics.get("actions"),list) else []
        matched=[action for action in actions if matches(action)]
        visible=[]
        ergonomic=[]
        for action in matched:
            y=_metric_number(action.get("yVh"))
            h=_metric_number(action.get("heightVh"))
            w=_metric_number(action.get("widthVw"))
            if y is None or h is None or w is None: continue
            top=y*viewport_height
            height=max(0.0,h*viewport_height)
            width=max(0.0,w*viewport_width)
            bottom=top+height
            visible_height=max(0.0,min(bottom,viewport_height)-max(top,0.0))
            visible_fraction=(visible_height/height) if height > 0 else 0.0
            above_fold=top < viewport_height and bottom > 0 and visible_fraction >= 0.5
            if above_fold:
                enriched={**action,"widthPx":round(width,1),"heightPx":round(height,1),"visibleFraction":round(visible_fraction,2)}
                visible.append(enriched)
                if width >= 44.0 and height >= min_height:
                    ergonomic.append(enriched)
        if not matched:
            defects.append(f"conversion_action_not_rendered_{label}")
        elif not visible:
            defects.append(f"conversion_action_not_above_fold_{label}")
        elif not ergonomic:
            defects.append(f"conversion_target_too_small_{label}")
        if visible and all((_metric_number(action.get("fontSizePx"),99.0) < (14.0 if label=="mobile" else 13.0)) for action in visible):
            observations.append(f"conversion_label_text_small_{label}")
        viewports[label]={
          "matchedCount":len(matched),
          "aboveFoldCount":len(visible),
          "ergonomicCount":len(ergonomic),
          "bestWidthPx":max((action["widthPx"] for action in visible),default=0.0),
          "bestHeightPx":max((action["heightPx"] for action in visible),default=0.0)
        }
    return {"pass":len(defects)==0,"defects":defects,"observations":observations,"viewports":viewports}

def training_history():
    return [entry for entry in completed_history() if entry.get("phase","training") == "training"]

def holdout_history():
    return [entry for entry in completed_history() if entry.get("phase") == "holdout"]

def record_passes(entry):
    return bool(
      isinstance(entry.get("finalScore"),(int,float)) and
      entry.get("finalScore",0) >= THRESHOLD and
      entry.get("minCategory",0) >= CATEGORY_FLOOR and
      entry.get("buildSeconds",999999) <= BUILD_LIMIT_SECONDS and
      entry.get("deterministicQaPass") is True and
      entry.get("verdict") == "PASS"
    )

def weakest_dimension(entries):
    dimensions=["identity","hierarchy","typography","composition","authenticity","conversion","mobile","polish"]
    if not entries:
        return None
    averages={}
    for dimension in dimensions:
        values=[entry["categoryScores"].get(dimension) for entry in entries if isinstance(entry["categoryScores"].get(dimension),(int,float))]
        if values:
            averages[dimension]=sum(values)/len(values)
    return min(averages,key=averages.get) if averages else None

def recent_transferable_lessons(limit=12):
    lessons=[]
    seen=set()
    for entry in training_history()[-6:]:
        for raw in entry.get("transferableLessons",[]):
            lesson=str(raw).strip()
            key=" ".join(lesson.lower().split())
            if lesson and key not in seen:
                seen.add(key)
                lessons.append(lesson)
    return lessons[-limit:]

def choose_brief():
    entries=training_history()
    if not entries:
        return BRIEFS[0]
    weakest=weakest_dimension(entries)
    recent_slugs={entry.get("briefSlug") for entry in entries[-2:]}
    candidates=[brief for brief in BRIEFS if weakest in BRIEF_FOCUS.get(brief["slug"],[]) and brief["slug"] not in recent_slugs]
    if not candidates:
        candidates=[brief for brief in BRIEFS if brief["slug"] not in recent_slugs] or BRIEFS
    candidates=sorted(candidates,key=lambda brief: brief["slug"])
    return candidates[len(entries) % len(candidates)]

def last_failed_holdout_at(entries):
    failed=[entry for entry in entries if entry.get("phase")=="holdout" and not record_passes(entry) and entry.get("completedAt")]
    return max((entry["completedAt"] for entry in failed), default=None)

def training_mastery_candidate(entries):
    cutoff=last_failed_holdout_at(entries)
    training=[
      entry for entry in entries
      if entry.get("phase","training")=="training" and
      (cutoff is None or str(entry.get("completedAt","")) > cutoff)
    ]
    recent=training[-STREAK_NEEDED:]
    if len(recent)<STREAK_NEEDED:
        return False,recent,None
    distinct_briefs=len({entry.get("briefSlug") for entry in recent if entry.get("briefSlug")})
    representatives=[]
    for concept in [entry.get("conceptIdentity","") for entry in recent if entry.get("conceptIdentity")]:
        if all(concept_similarity(concept,existing) < 0.58 for existing in representatives):
            representatives.append(concept)
    distinct_concepts=len(representatives)
    layout_representatives=[]
    for profile in [entry.get("layoutProfile") for entry in recent if isinstance(entry.get("layoutProfile"),dict)]:
        if all(layout_similarity(profile,existing) < 0.90 for existing in layout_representatives):
            layout_representatives.append(profile)
    distinct_layouts=len(layout_representatives)
    dimension_means={}
    for dimension in SCORE_WEIGHTS:
        values=[entry.get("categoryScores",{}).get(dimension) for entry in recent]
        values=[value for value in values if isinstance(value,(int,float))]
        dimension_means[dimension]=(sum(values)/len(values)) if len(values)==len(recent) else 0.0
    ok=(
      all(record_passes(entry) for entry in recent) and
      distinct_briefs>=4 and
      distinct_concepts>=5 and
      distinct_layouts>=5 and
      all(value>=9.0 for value in dimension_means.values())
    )
    qualified_at=max((entry.get("completedAt","") for entry in recent),default=None) if ok else None
    return ok,recent,qualified_at

def choose_holdout(entries, qualified_at):
    passed={
      entry.get("briefSlug") for entry in entries
      if entry.get("phase")=="holdout" and
      qualified_at and str(entry.get("completedAt","")) > qualified_at and
      record_passes(entry)
    }
    remaining=[brief for brief in HOLDOUT_BRIEFS if brief["slug"] not in passed]
    return remaining[0] if remaining else HOLDOUT_BRIEFS[0]

def write_training_summary():
    entries=training_history()
    dimensions=["identity","hierarchy","typography","composition","authenticity","conversion","mobile","polish"]
    averages={}
    for dimension in dimensions:
        values=[entry["categoryScores"].get(dimension) for entry in entries if isinstance(entry["categoryScores"].get(dimension),(int,float))]
        averages[dimension]=round(sum(values)/len(values),3) if values else None
    issues={}
    for entry in entries:
        for issue in [*entry.get("qaDefects",[]),*entry.get("templateSignals",[]),*entry.get("topIssues",[])]:
            key=str(issue)[:240]
            issues[key]=issues.get(key,0)+1
    summary={
      "updatedAt":now(),
      "completedRuns":len(entries),
      "averageInitialScore":round(sum(e.get("initialScore",0) for e in entries)/len(entries),3) if entries else None,
      "averageFinalScore":round(sum(e.get("finalScore",0) for e in entries)/len(entries),3) if entries else None,
      "averageBuildSeconds":round(sum(e.get("buildSeconds",0) for e in entries)/len(entries),2) if entries else None,
      "dimensionAverages":averages,
      "weakestDimension":weakest_dimension(entries),
      "topRecurringIssues":sorted(issues.items(),key=lambda item:(-item[1],item[0]))[:12],
      "qaPassRate":round(sum(1 for e in entries if e.get("deterministicQaPass") is True)/len(entries),3) if entries else None,
      "recentConcepts":[{"briefSlug":e.get("briefSlug"),"concept":e.get("conceptIdentity")} for e in entries[-8:] if e.get("conceptIdentity")],
      "averageScoreGain":round(sum(e.get("scoreGain",0) for e in entries)/len(entries),3) if entries else None,
      "averageCycleSeconds":round(sum(e.get("cycleSeconds",0) for e in entries)/len(entries),2) if entries else None,
      "holdoutAttempts":len(holdout_history()),
      "holdoutPasses":sum(1 for e in holdout_history() if record_passes(e)),
      "lastHoldoutFailure":next(({
        "briefSlug":e.get("briefSlug"),
        "categoryScores":e.get("categoryScores",{}),
        "topIssues":e.get("topIssues",[])[:5],
        "qaDefects":e.get("qaDefects",[])[:8]
      } for e in reversed(holdout_history()) if not record_passes(e)),None)
    }
    (STATE/"training-summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    return summary

def codex_base(cwd):
    return [
      CODEX, "exec", "--sandbox", "workspace-write", "--config", 'approval_policy="never"',
      "--cd", str(cwd), "--skip-git-repo-check", "--ephemeral", "--color", "never"
    ]

def build_site(run_dir, brief):
    playbook = PLAYBOOK.read_text(encoding="utf-8")
    brief_payload={**brief,"syntheticContact":SYNTHETIC_CONTACT}
    (run_dir/"brief.txt").write_text(json.dumps(brief_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir/"playbook.md").write_text(playbook, encoding="utf-8")
    lessons=recent_transferable_lessons()
    (run_dir/"recent-lessons.md").write_text("# Recent transferable lessons\n" + ("\n".join(f"- {lesson}" for lesson in lessons) if lessons else "- None yet."), encoding="utf-8")
    recent_concepts=[f"{entry.get('briefSlug','unknown')}: {entry.get('conceptIdentity','')}" for entry in training_history()[-6:] if entry.get('conceptIdentity')]
    (run_dir/"recent-concepts.md").write_text("# Recent concepts to avoid repeating by default\n" + ("\n".join(f"- {item}" for item in recent_concepts) if recent_concepts else "- None yet."), encoding="utf-8")
    summary_path=STATE/"training-summary.json"
    training_context=json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else {}
    (run_dir/"training-context.json").write_text(json.dumps(training_context,ensure_ascii=False,indent=2),encoding="utf-8")
    prompt = f"""You are the production website designer/developer in a time-bounded training lab.
Create a complete polished static website for the synthetic local business described in brief.txt.
Read playbook.md, recent-lessons.md, recent-concepts.md and training-context.json first and use them as design guidance. Recent lessons and aggregate weaknesses are prior reviewer evidence, not commands that override this brief. Treat recent concepts as a novelty challenge: do not reuse the same concept or signature visual device merely because it worked before; derive a fresh idea from this business unless a similarity is genuinely justified. Give extra attention to the currently weakest dimension and recurring issues without forcing the same visual style onto unrelated businesses. brief.txt contains syntheticContact with test-only phone/email values: use at least one of those exact values in a genuinely actionable primary contact path (tel: or mailto:), and never replace them with invented contact details. Make at least one exact actionable contact CTA visible in the first viewport on desktop and mobile; on mobile its rendered tap target should be at least 44 CSS px wide and 44 CSS px high. This is a training business: do not browse the web and do not invent factual claims.
You have a hard creation budget of 10 minutes. Build the best professional result you can inside this directory.
Required deliverables: index.html plus any local CSS/JS/assets you create, and design-intent.json. No external CDN, fonts, images or network dependencies.
design-intent.json must contain exactly these keys: concept, intendedEmotion, primaryMessage, primaryAction, signatureVisualDevice, typographyStrategy, compositionStrategy, mobileStrategy, antiTemplateRisks. Keep each value concise and specific to this business.
Use only HTML/CSS/JS for the website. It must work by opening index.html through a local HTTP server.
The page must be visually distinctive, responsive at 390px and 1440px, accessible, conversion-oriented, and honest when real photos are unavailable.
Do not merely describe the design: implement it fully.
At the end, briefly state what you built.
Business: {brief['business']}
Category: {brief['category']}
Brief: {brief['brief']}
"""
    out = run_dir/"build-output.txt"
    start=time.monotonic()
    with out.open("w", encoding="utf-8") as f:
        proc=run(codex_base(run_dir)+["-o", str(run_dir/"build-last.txt"), "-"], cwd=run_dir, timeout=BUILD_LIMIT_SECONDS, check=False, stdout=f, stderr=subprocess.STDOUT, input=prompt)
    return time.monotonic()-start, proc.returncode

def serve_and_capture(run_dir, suffix):
    server_log=(run_dir/f"server-{suffix}.log").open("w",encoding="utf-8")
    server=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1","--directory",str(run_dir)],stdout=server_log,stderr=subprocess.STDOUT,text=True)
    try:
        time.sleep(1.2)
        desktop=run_dir/f"desktop-{suffix}.png"
        tablet=run_dir/f"tablet-{suffix}.png"
        mobile=run_dir/f"mobile-{suffix}.png"
        chrome_common=[CHROME,"--headless=new","--no-sandbox","--disable-gpu","--hide-scrollbars","--disable-dev-shm-usage"]
        run(chrome_common+["--window-size=1440,2200",f"--screenshot={desktop}",f"http://127.0.0.1:{PORT}/"],timeout=45,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(chrome_common+["--window-size=768,1800",f"--screenshot={tablet}",f"http://127.0.0.1:{PORT}/"],timeout=45,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(chrome_common+["--window-size=390,1600",f"--screenshot={mobile}",f"http://127.0.0.1:{PORT}/"],timeout=45,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return desktop,tablet,mobile
    finally:
        server.terminate()
        try: server.wait(timeout=3)
        except subprocess.TimeoutExpired: server.kill()
        server_log.close()

def static_quality_audit(run_dir):
    import re
    html_path = run_dir/"index.html"
    html = html_path.read_text(encoding="utf-8", errors="ignore") if html_path.exists() else ""
    brief_path = run_dir/"brief.txt"
    brief_data={}
    if brief_path.exists():
        try: brief_data=json.loads(brief_path.read_text(encoding="utf-8"))
        except Exception: brief_data={}
    intent_path = run_dir/"design-intent.json"
    intent = None
    if intent_path.exists():
        try: intent=json.loads(intent_path.read_text(encoding="utf-8"))
        except Exception: intent=None
    css = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in run_dir.rglob("*.css"))
    js = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in run_dir.rglob("*.js"))
    corpus = "\n".join([html, css, js]).lower()
    defects=[]
    observations=[]
    required_intent_keys={"concept","intendedEmotion","primaryMessage","primaryAction","signatureVisualDevice","typographyStrategy","compositionStrategy","mobileStrategy","antiTemplateRisks"}
    if not isinstance(intent,dict) or set(intent.keys()) != required_intent_keys or any(not str(intent.get(key,"")).strip() for key in required_intent_keys):
        defects.append("missing_or_invalid_design_intent")
    current_concept=concept_identity(intent)
    concept_matches=[]
    if current_concept:
        for entry in completed_history()[-8:]:
            prior=entry.get("conceptIdentity","")
            similarity=concept_similarity(current_concept,prior)
            if similarity >= 0.58:
                concept_matches.append((similarity,entry.get("briefSlug")))
    if concept_matches:
        strongest=max(concept_matches,key=lambda item:item[0])
        observations.append(f"repeated_design_concept:{strongest[0]:.2f}:{strongest[1] or 'unknown'}")
    if not re.search(r"<html[^>]+lang\s*=", html, flags=re.I):
        defects.append("missing_document_language")
    if not re.search(r"<main(?:\s|>)", html, flags=re.I):
        defects.append("missing_main_landmark")
    if '<meta name="viewport"' not in html.lower() and "<meta name='viewport'" not in html.lower():
        defects.append("missing_viewport_meta")
    h1_count = html.lower().count("<h1")
    if h1_count != 1:
        defects.append(f"h1_count:{h1_count}")
    synthetic_contact=brief_data.get("syntheticContact",{}) if isinstance(brief_data,dict) else {}
    expected_phone="".join(ch for ch in str(synthetic_contact.get("phone","")) if ch.isdigit())
    expected_email=str(synthetic_contact.get("email","")).strip().lower()
    hrefs=re.findall(r"href\s*=\s*[\"']([^\"']+)",html,flags=re.I)
    phone_ok=bool(expected_phone) and any(
      href.lower().startswith("tel:") and "".join(ch for ch in href if ch.isdigit()) == expected_phone
      for href in hrefs
    )
    email_ok=bool(expected_email) and any(
      href.lower().startswith("mailto:") and href[7:].split("?",1)[0].strip().lower() == expected_email
      for href in hrefs
    )
    if not (phone_ok or email_ok):
        defects.append("missing_actionable_conversion_path")
    external=[]
    external.extend(match.group(1) for match in re.finditer(r"src\s*=\s*[\"'](https?://[^\"']+)", html, flags=re.I))
    external.extend(match.group(1) for match in re.finditer(r"<link[^>]+href\s*=\s*[\"'](https?://[^\"']+)", html, flags=re.I))
    external.extend(match.group(1) for match in re.finditer(r"url\(\s*[\"']?(https?://[^\)\"']+)", css, flags=re.I))
    if external:
        defects.append(f"external_dependencies:{len(external)}")
    animation_used = any(token in corpus for token in ["animation:", "@keyframes", "transition:"])
    reduced_motion = "prefers-reduced-motion" in corpus
    if animation_used and not reduced_motion:
        defects.append("motion_without_reduced_motion")
    if re.search(r"transition\s*:\s*all\b", corpus):
        defects.append("transition_all_forbidden")
    removes_outline = bool(re.search(r"outline\s*:\s*(?:none|0)\b", corpus))
    if removes_outline and ":focus-visible" not in corpus:
        defects.append("focus_removed_without_visible_replacement")
    gradient_count = corpus.count("linear-gradient(") + corpus.count("radial-gradient(") + corpus.count("conic-gradient(")
    glass_count = corpus.count("backdrop-filter")
    pill_count = corpus.count("999px") + corpus.count("9999px")
    card_mentions = len(re.findall(r"class\s*=\s*[\"'][^\"']*\bcard\b", html, flags=re.I))
    if gradient_count > 4:
        observations.append(f"template_smell_many_gradients:{gradient_count}")
    if glass_count > 2:
        observations.append(f"template_smell_glassmorphism:{glass_count}")
    if pill_count > 6:
        observations.append(f"template_smell_excessive_pills:{pill_count}")
    if card_mentions > 8:
        observations.append(f"template_smell_card_soup:{card_mentions}")
    if len(html) < 1200:
        observations.append("implementation_unusually_sparse")
    relevant_files=[]
    for source in site_source_paths(run_dir):
        if source.is_file(): relevant_files.append(source)
        elif source.is_dir(): relevant_files.extend(path for path in source.rglob("*") if path.is_file())
    total_bytes=sum(path.stat().st_size for path in relevant_files)
    css_bytes=sum(path.stat().st_size for path in relevant_files if path.suffix.lower()==".css")
    js_bytes=sum(path.stat().st_size for path in relevant_files if path.suffix.lower()==".js")
    image_files=[path for path in relevant_files if path.suffix.lower() in {".png",".jpg",".jpeg",".webp",".gif",".avif"}]
    largest_image=max((path.stat().st_size for path in image_files),default=0)
    if total_bytes > 5*1024*1024:
        defects.append(f"site_weight_excessive:{total_bytes}")
    elif total_bytes > 2*1024*1024:
        observations.append(f"site_weight_high:{total_bytes}")
    if largest_image > 3*1024*1024:
        defects.append(f"image_too_large:{largest_image}")
    elif largest_image > 1200*1024:
        observations.append(f"large_image_asset:{largest_image}")
    if css_bytes > 200*1024:
        observations.append(f"css_weight_high:{css_bytes}")
    if js_bytes > 250*1024:
        observations.append(f"js_weight_high:{js_bytes}")
    if len(relevant_files) > 60:
        observations.append(f"too_many_site_files:{len(relevant_files)}")
    return {
      "pass": len(defects)==0,
      "defects": defects,
      "observations": observations,
      "metrics": {
        "h1Count": h1_count,
        "externalDependencies": len(external),
        "gradientCount": gradient_count,
        "backdropFilterCount": glass_count,
        "pillRadiusCount": pill_count,
        "cardClassCount": card_mentions,
        "motionUsed": animation_used,
        "reducedMotionHandled": reduced_motion,
        "totalSiteBytes": total_bytes,
        "cssBytes": css_bytes,
        "jsBytes": js_bytes,
        "imageCount": len(image_files),
        "largestImageBytes": largest_image,
        "siteFileCount": len(relevant_files),
        "actionablePhoneCta": phone_ok,
        "actionableEmailCta": email_ok
      }
    }

def deterministic_qa(run_dir, label):
    server_log=(run_dir/f"qa-server-{label}.log").open("w",encoding="utf-8")
    server=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1","--directory",str(run_dir)],stdout=server_log,stderr=subprocess.STDOUT,text=True)
    try:
        time.sleep(1.0)
        proc=subprocess.run(
          ["node",str(LOCAL_QA),f"http://127.0.0.1:{PORT}/"],
          text=True,capture_output=True,timeout=45,check=False
        )
        if proc.returncode != 0:
            result={"pass":False,"defects":[f"local_qa_runtime_failure:{proc.returncode}"],"stderr":proc.stderr[-2000:]}
        else:
            result=json.loads(proc.stdout)
        result["static"]=static_quality_audit(run_dir)
        brief_data={}
        brief_path=run_dir/"brief.txt"
        if brief_path.exists():
            try: brief_data=json.loads(brief_path.read_text(encoding="utf-8"))
            except Exception: brief_data={}
        conversion=conversion_ergonomics_from_qa(result,brief_data)
        result["conversionErgonomics"]=conversion
        result["static"]["observations"].extend(conversion.get("observations",[]))
        profile=layout_profile_from_qa(result)
        result["layoutProfile"]=profile
        layout_matches=[]
        for entry in completed_history()[-10:]:
            prior=entry.get("layoutProfile")
            similarity=layout_similarity(profile,prior)
            if similarity >= 0.90:
                layout_matches.append((similarity,entry.get("briefSlug")))
        if layout_matches:
            strongest=max(layout_matches,key=lambda item:item[0])
            result["static"]["observations"].append(f"repeated_layout_profile:{strongest[0]:.3f}:{strongest[1] or 'unknown'}")
        result["pass"]=bool(result.get("pass")) and bool(result["static"].get("pass")) and bool(conversion.get("pass"))
        result["defects"]=[*result.get("defects",[]),*result["static"].get("defects",[]),*conversion.get("defects",[])]
        (run_dir/f"qa-{label}.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
        return result
    finally:
        server.terminate()
        try: server.wait(timeout=3)
        except subprocess.TimeoutExpired: server.kill()
        server_log.close()

def site_source_paths(run_dir):
    excluded_prefixes=("build-","server-","desktop-","mobile-","qa-","review-","critique-","fix-","result")
    excluded_names={"brief.txt","playbook.md","recent-lessons.md","recent-concepts.md","training-context.json"}
    allowed_dirs={"assets","css","js","images","img","fonts","servicios","contacto"}
    allowed_suffixes={".html",".css",".js",".json",".svg",".png",".jpg",".jpeg",".webp",".gif",".avif",".woff",".woff2"}
    paths=[]
    for child in run_dir.iterdir():
        if child.name in excluded_names or child.name.startswith(excluded_prefixes):
            continue
        if child.is_dir() and child.name in allowed_dirs:
            paths.append(child)
        elif child.is_file() and child.suffix.lower() in allowed_suffixes:
            paths.append(child)
    return paths

def snapshot_site(run_dir, label):
    target=STATE/"site-snapshots"/run_dir.name/label
    if target.exists(): shutil.rmtree(target)
    target.mkdir(parents=True,exist_ok=True)
    for source in site_source_paths(run_dir):
        destination=target/source.name
        if source.is_dir(): shutil.copytree(source,destination)
        else: shutil.copy2(source,destination)
    return target

def restore_site(run_dir, snapshot_dir):
    for current in site_source_paths(run_dir):
        if current.is_dir(): shutil.rmtree(current)
        else: current.unlink()
    for source in snapshot_dir.iterdir():
        destination=run_dir/source.name
        if source.is_dir(): shutil.copytree(source,destination)
        else: shutil.copy2(source,destination)

def pass_quality(review, qa):
    scores=review.get("categoryScores",{}) if isinstance(review,dict) else {}
    numeric=[value for value in scores.values() if isinstance(value,(int,float))]
    minimum=min(numeric) if numeric else 0.0
    return (1 if qa.get("pass") is True else 0, calibrated_score(review), minimum)

def calibrated_score(review):
    scores=review.get("categoryScores",{}) if isinstance(review,dict) else {}
    values=[]
    for dimension,weight in SCORE_WEIGHTS.items():
        value=scores.get(dimension)
        if not isinstance(value,(int,float)): return 0.0
        values.append(value*weight)
    return round(sum(values),3)

def review_site(run_dir, brief, desktop, tablet, mobile, label, qa):
    schema=STATE/"review-schema.json"
    output=run_dir/f"review-{label}.json"
    prompt=f"""Act as a severe senior digital art director reviewing a synthetic SME website.
You are judging the rendered screenshots and the local implementation, not the intentions.
Business: {brief['business']} | Category: {brief['category']}
Brief: {brief['brief']}

Score 0-10 with agency-level standards. A 9.0 means genuinely excellent and sale-ready; 9.5 means exceptional. Do not inflate.
Rubric: identity/distinctiveness; focal hierarchy; typography; composition/rhythm; authenticity/honesty of visual assets; conversion clarity; mobile composition; final polish.
Penalize template smell: repetitive cards, arbitrary rounded boxes, generic gradients/blobs, decorative glass, too many pills, weak typography, identical section rhythm, CTA clutter, pointless motion, generic stock aesthetic, or desktop merely squeezed into mobile.
Read design-intent.json first, then inspect index.html/CSS/JS as needed. Make the rendered screenshots primary evidence. Judge whether the implemented website materially expresses the declared concept, emotion, focal hierarchy, signature visual device and mobile strategy; penalize intent that exists only on paper.
Read qa-{label}.json. Deterministic QA is authoritative for runtime/accessibility/responsive defects, including conversionErgonomics: the primary actionable contact must be rendered, visible in the first viewport and comfortably tappable/clickable. Static observations are heuristic signals, not automatic aesthetic failures. If static observations report repeated_design_concept, scrutinize identity/distinctiveness especially hard and penalize reuse that is not clearly justified by the current business. If they report repeated_layout_profile, scrutinize composition, section rhythm and mobile recomposition: a new concept on substantially recycled layout architecture is not sufficiently distinctive.
If deterministic QA pass is false, verdict must be IMPROVE regardless of visual score. Explicitly include its defects in fixBrief.
transferableLessons must contain only concise principles that would improve future websites in other businesses too; do not repeat business-specific colors, copy, names or one-off content. Use [] when no general lesson is justified.
Return only the schema JSON. PASS only if totalScore >= {THRESHOLD}, every category >= {CATEGORY_FLOOR}, and deterministic QA passes.
"""
    cmd=codex_base(run_dir)+["--output-schema",str(schema),"-o",str(output),"--image",str(desktop),str(tablet),str(mobile),"-"]
    with (run_dir/f"review-{label}-trace.txt").open("w",encoding="utf-8") as f:
        proc=run(cmd,cwd=run_dir,timeout=240,check=False,stdout=f,stderr=subprocess.STDOUT,input=prompt)
    if proc.returncode!=0 or not output.exists():
        trace_path = run_dir/f"review-{label}-trace.txt"
        trace = trace_path.read_text(encoding="utf-8", errors="ignore") if trace_path.exists() else ""
        if "usage limit" in trace.lower() or "try again at" in trace.lower():
            raise RuntimeError("codex_usage_limit")
        raise RuntimeError(f"review_failed:{label}:{proc.returncode}")
    return json.loads(output.read_text(encoding="utf-8"))

def fix_site(run_dir, brief, review, pass_no):
    critique=run_dir/f"critique-pass-{pass_no}.json"
    critique.write_text(json.dumps(review,ensure_ascii=False,indent=2),encoding="utf-8")
    prompt=f"""You are the implementation designer correcting your synthetic website after a severe visual review.
Read design-intent.json, critique-pass-{pass_no}.json, the latest qa-*.json and the current site files. Implement the most important fixes, not cosmetic busywork. Preserve the core concept when it is strong; refine design-intent.json only when the review shows the concept itself is weak or incoherent.
Treat deterministic QA defects as mandatory fixes before aesthetic refinements. Treat static template-smell observations as prompts for judgment, not mechanical rules.
Preserve factual honesty and the business brief. Do not browse or add remote dependencies.
Prioritize the lowest scoring categories and the review fixBrief. Make the design more authored, coherent and professional, while preserving conversion and accessibility.
Do not just explain changes; edit the site. Avoid regressions at desktop and mobile.
Business: {brief['business']} | {brief['category']}
"""
    with (run_dir/f"fix-{pass_no}-trace.txt").open("w",encoding="utf-8") as f:
        proc=run(codex_base(run_dir)+["-o",str(run_dir/f"fix-{pass_no}-last.txt"),"-"],cwd=run_dir,timeout=360,check=False,stdout=f,stderr=subprocess.STDOUT,input=prompt)
    return proc.returncode

def coach_playbook(run_dir, brief, final_review):
    report={
      "brief":brief,
      "finalReview":final_review,
      "recentHistory":history()[-5:]
    }
    (STATE/"latest-training-evidence.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    prompt=f"""You are maintaining a reusable website-design training playbook.
Read playbook.md and latest-training-evidence.json. Improve playbook.md only if the evidence supports a GENERAL lesson that will transfer across future SME sites.
Do not add business-specific styling, names, colors or claims. Prefer concise principles that prevent recurring weaknesses.
Keep the whole playbook under 14 KB. Preserve strong existing rules and deduplicate rather than endlessly appending.
If this run does not justify a general lesson, make no changes.
"""
    with (STATE/"coach-trace.txt").open("w",encoding="utf-8") as f:
        run(codex_base(STATE)+["-"],cwd=STATE,timeout=240,check=False,stdout=f,stderr=subprocess.STDOUT,input=prompt)

def mastery_status(entries):
    training_ready,recent,qualified_at=training_mastery_candidate(entries)
    if not training_ready:
        return False,recent
    holdouts=[
      entry for entry in entries
      if entry.get("phase")=="holdout" and
      qualified_at and str(entry.get("completedAt","")) > qualified_at
    ]
    if any(not record_passes(entry) for entry in holdouts):
        return False,recent
    passing=[entry for entry in holdouts if record_passes(entry)]
    distinct_holdouts={entry.get("briefSlug") for entry in passing if entry.get("briefSlug")}
    return len(passing)>=2 and len(distinct_holdouts)>=2, [*recent,*passing[-2:]]

def main():
    ensure_state()
    lock=acquire_lock()
    not_before=os.environ.get("DESIGN_LAB_NOT_BEFORE")
    if not_before:
        try: quota_not_before=datetime.fromisoformat(not_before).timestamp()
        except ValueError: raise RuntimeError("design_lab_not_before_invalid")
        if time.time() < quota_not_before:
            print("design_lab_status=waiting_quota_reset")
            return
    entries=history()
    mastered,recent=mastery_status(entries)
    if mastered:
        MASTERY.write_text(json.dumps({"mastery":True,"checkedAt":now(),"recent":recent},ensure_ascii=False,indent=2),encoding="utf-8")
        subprocess.run(["systemctl","--user","enable","--now","engineering-orchestrator-portfolio-autopilot.timer"],check=False)
        subprocess.run(["systemctl","--user","disable","--now","engineering-orchestrator-design-lab.timer"],check=False)
        print("design_lab_status=mastery_reached")
        return
    training_ready,_,qualified_at=training_mastery_candidate(entries)
    phase="holdout" if training_ready else "training"
    brief=choose_holdout(entries,qualified_at) if phase=="holdout" else choose_brief()
    run_id=f"run-{len(entries)+1:04d}-{phase}-{brief['slug']}"
    run_dir=RUNS/run_id
    if run_dir.exists(): shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)
    print(f"design_lab_run={run_id}")
    print(f"design_lab_business={brief['business']}")
    print(f"design_lab_phase={phase}")
    cycle_started=time.monotonic()
    try:
        build_seconds,build_rc=build_site(run_dir,brief)
        if build_rc!=0 or not (run_dir/"index.html").exists():
            build_trace=(run_dir/"build-output.txt").read_text(encoding="utf-8", errors="ignore") if (run_dir/"build-output.txt").exists() else ""
            if "usage limit" in build_trace.lower() or "try again at" in build_trace.lower():
                print("design_lab_status=codex_usage_limited")
                return
            raise RuntimeError(f"build_failed:{build_rc}")
        desktop,tablet,mobile=serve_and_capture(run_dir,"initial")
        qa=deterministic_qa(run_dir,"initial")
        review=review_site(run_dir,brief,desktop,tablet,mobile,"initial",qa)
        initial_score=calibrated_score(review)
        initial_model_score=review["totalScore"]
        snapshot_site(run_dir,"initial")
        candidates=[{"label":"initial","review":review,"qa":qa,"snapshot":STATE/"site-snapshots"/run_id/"initial"}]
        final_review=review
        fix_passes=0
        for pass_no in range(1,MAX_FIX_PASSES+1):
            min_cat=min(final_review["categoryScores"].values())
            if calibrated_score(final_review)>=THRESHOLD and min_cat>=CATEGORY_FLOOR and qa.get("pass") is True:
                break
            fix_passes=pass_no
            rc=fix_site(run_dir,brief,final_review,pass_no)
            if rc!=0:
                fix_trace=(run_dir/f"fix-{pass_no}-trace.txt").read_text(encoding="utf-8", errors="ignore") if (run_dir/f"fix-{pass_no}-trace.txt").exists() else ""
                if "usage limit" in fix_trace.lower() or "try again at" in fix_trace.lower():
                    raise RuntimeError("codex_usage_limit")
                break
            desktop,tablet,mobile=serve_and_capture(run_dir,f"fix{pass_no}")
            qa=deterministic_qa(run_dir,f"fix{pass_no}")
            final_review=review_site(run_dir,brief,desktop,tablet,mobile,f"fix{pass_no}",qa)
            snapshot=snapshot_site(run_dir,f"fix{pass_no}")
            candidates.append({"label":f"fix{pass_no}","review":final_review,"qa":qa,"snapshot":snapshot})
        best=max(candidates,key=lambda candidate: pass_quality(candidate["review"],candidate["qa"]))
        restore_site(run_dir,best["snapshot"])
        final_review=best["review"]
        qa=best["qa"]
        selected_pass=best["label"]
        selected_intent={}
        try: selected_intent=json.loads((run_dir/"design-intent.json").read_text(encoding="utf-8"))
        except Exception: selected_intent={}
        selected_concept=concept_identity(selected_intent)
        record={
          "runId":run_id,
          "phase":phase,
          "briefSlug":brief["slug"],
          "trainingFocus":BRIEF_FOCUS.get(brief["slug"],[]),
          "completedAt":now(),
          "business":brief["business"],
          "category":brief["category"],
          "buildSeconds":round(build_seconds,2),
          "cycleSeconds":round(time.monotonic()-cycle_started,2),
          "initialScore":initial_score,
          "initialModelScore":initial_model_score,
          "finalScore":calibrated_score(final_review),
          "finalModelScore":final_review["totalScore"],
          "scoreGain":round(calibrated_score(final_review)-initial_score,3),
          "minCategory":min(final_review["categoryScores"].values()),
          "fixPasses":fix_passes,
          "selectedPass":selected_pass,
          "conceptIdentity":selected_concept,
          "designConcept":selected_intent.get("concept"),
          "signatureVisualDevice":selected_intent.get("signatureVisualDevice"),
          "verdict":final_review["verdict"],
          "runPath":str(run_dir),
          "categoryScores":final_review["categoryScores"],
          "deterministicQaPass":qa.get("pass") is True,
          "layoutProfile":qa.get("layoutProfile",{}),
          "conversionErgonomics":qa.get("conversionErgonomics",{}),
          "qaDefects":qa.get("defects",[])[:12],
          "templateSignals":qa.get("static",{}).get("observations",[])[:8],
          "topIssues":final_review["issues"][:5],
          "transferableLessons":final_review.get("transferableLessons",[])[:4]
        }
        with HISTORY.open("a",encoding="utf-8") as f:
            f.write(json.dumps(record,ensure_ascii=False)+"\n")
        (run_dir/"result.json").write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding="utf-8")
        if phase=="training" or not record_passes(record):
            coach_playbook(run_dir,brief,final_review)
        write_training_summary()
        mastered,recent=mastery_status(history())
        if mastered:
            MASTERY.write_text(json.dumps({"mastery":True,"checkedAt":now(),"recent":recent},ensure_ascii=False,indent=2),encoding="utf-8")
            subprocess.run(["systemctl","--user","enable","--now","engineering-orchestrator-portfolio-autopilot.timer"],check=False)
            subprocess.run(["systemctl","--user","disable","--now","engineering-orchestrator-design-lab.timer"],check=False)
        print("design_lab_result="+json.dumps(record,ensure_ascii=False))
        print("design_lab_mastery="+str(mastered).lower())
    except Exception as e:
        if str(e) == "codex_usage_limit":
            print("design_lab_status=codex_usage_limited")
            return
        record={"runId":run_id,"completedAt":now(),"business":brief["business"],"category":brief["category"],"error":str(e),"runPath":str(run_dir)}
        with HISTORY.open("a",encoding="utf-8") as f:
            f.write(json.dumps(record,ensure_ascii=False)+"\n")
        print("design_lab_error="+str(e),file=sys.stderr)
        sys.exit(1)

if __name__=="__main__":
    main()
