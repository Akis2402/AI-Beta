'use client';

import React, { useState, useEffect } from 'react';
import { FORMULA_SUBJECTS, FORMULA_LIBRARY } from '@/lib/data/formulas';

interface FormulaPanelProps {
  schoolGrade: string;
}

export default function FormulaPanel({ schoolGrade }: FormulaPanelProps) {
  const [selectedSubject, setSelectedSubject] = useState('toan');
  const gradeKey = schoolGrade || '10';

  const formulas =
    FORMULA_LIBRARY[selectedSubject]?.[gradeKey] ||
    FORMULA_LIBRARY[selectedSubject]?.['10'] ||
    [];

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).renderMathInElement) {
      const el = document.getElementById('formulaList');
      if (el) {
        try {
          (window as any).renderMathInElement(el, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false },
              { left: '\\(', right: '\\)', display: false },
              { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false
          });
        } catch {}
      }
    }
  }, [selectedSubject, gradeKey, formulas]);

  return (
    <div>
      <div className="panel-head">
        <h2>Công thức cốt lõi</h2>
        <span className="panel-sub" id="formulaGradeHint">
          Theo Lớp {gradeKey}
        </span>
      </div>

      <div id="formulaSubjectTabs">
        {FORMULA_SUBJECTS.map((sub) => (
          <button
            key={sub.key}
            className={`chip ${selectedSubject === sub.key ? 'active' : ''}`}
            onClick={() => setSelectedSubject(sub.key)}
          >
            <span>{sub.icon}</span> {sub.label}
          </button>
        ))}
      </div>

      <div id="formulaList">
        {formulas.length === 0 ? (
          <div className="panel-empty">
            Chưa có công thức cho môn học hoặc khối lớp này.
          </div>
        ) : (
          formulas.map((item, idx) => (
            <div key={idx} className="formula-card">
              <div className="formula-title">{item.name}</div>
              <div className="formula-latex">$${item.formula}$$</div>
              {item.note && <div className="formula-note">{item.note}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
