export interface FormulaItem {
  name: string;
  formula: string;
  note?: string;
}

export interface FormulaSubject {
  key: string;
  label: string;
  icon: string;
}

export const FORMULA_SUBJECTS: FormulaSubject[] = [
  { key: 'toan', label: 'Toán học', icon: '📐' },
  { key: 'vatly', label: 'Vật lý', icon: '⚛️' },
  { key: 'hoahoc', label: 'Hóa học', icon: '🧪' }
];

export const FORMULA_LIBRARY: Record<string, Record<string, FormulaItem[]>> = {
  toan: {
    '1': [
      { name: 'Phép cộng, trừ phạm vi 100', formula: 'a + b = c \\quad,\\quad c - b = a' },
      { name: 'So sánh số', formula: 'a > b,\\ a < b,\\ a = b' }
    ],
    '2': [
      { name: 'Bảng nhân, chia (2–5)', formula: 'a \\times b = c \\quad,\\quad c \\div b = a' },
      { name: 'Chu vi tứ giác', formula: 'P = a + b + c + d' }
    ],
    '3': [
      { name: 'Chu vi hình chữ nhật', formula: 'P = (a + b) \\times 2' },
      { name: 'Diện tích hình chữ nhật', formula: 'S = a \\times b' },
      { name: 'Chu vi hình vuông', formula: 'P = a \\times 4' },
      { name: 'Diện tích hình vuông', formula: 'S = a^2' }
    ],
    '4': [
      { name: 'Diện tích hình bình hành', formula: 'S = a \\times h' },
      { name: 'Diện tích hình thoi', formula: 'S = \\dfrac{d_1 \\times d_2}{2}' },
      { name: 'Trung bình cộng', formula: '\\overline{x} = \\dfrac{a_1 + a_2 + \\dots + a_n}{n}' }
    ],
    '5': [
      { name: 'Diện tích tam giác', formula: 'S = \\dfrac{a \\times h}{2}' },
      { name: 'Diện tích hình thang', formula: 'S = \\dfrac{(a + b) \\times h}{2}' },
      { name: 'Chu vi & diện tích hình tròn', formula: 'C = 2\\pi r,\\quad S = \\pi r^2' },
      { name: 'Thể tích hình hộp chữ nhật', formula: 'V = a \\times b \\times c' },
      { name: 'Thể tích hình lập phương', formula: 'V = a^3' }
    ],
    '6': [
      { name: 'Lũy thừa với số mũ tự nhiên', formula: 'a^n = a \\times a \\times \\dots \\times a' },
      { name: 'Cộng, trừ phân số', formula: '\\dfrac{a}{b} + \\dfrac{c}{d} = \\dfrac{ad + bc}{bd}' },
      { name: 'Nhân, chia phân số', formula: '\\dfrac{a}{b} \\times \\dfrac{c}{d} = \\dfrac{ac}{bd},\\quad \\dfrac{a}{b} \\div \\dfrac{c}{d} = \\dfrac{ad}{bc}' }
    ],
    '7': [
      { name: 'Lũy thừa của tích và thương', formula: '(ab)^n = a^n b^n,\\quad \\left(\\dfrac{a}{b}\\right)^n = \\dfrac{a^n}{b^n}' },
      { name: 'Tính chất dãy tỉ số bằng nhau', formula: '\\dfrac{a}{b} = \\dfrac{c}{d} = \\dfrac{a+c}{b+d} = \\dfrac{a-c}{b-d}' },
      { name: 'Định lý Pytago', formula: 'a^2 + b^2 = c^2' }
    ],
    '8': [
      { name: '7 hằng đẳng thức đáng nhớ', formula: '(a+b)^2 = a^2 + 2ab + b^2,\\quad a^2 - b^2 = (a-b)(a+b)' },
      { name: 'Định lý Ta-lét trong tam giác', formula: '\\dfrac{AB\'}{AB} = \\dfrac{AC\'}{AC} = \\dfrac{B\'C\'}{BC}' }
    ],
    '9': [
      { name: 'Hệ thức lượng tam giác vuông', formula: 'b^2 = a \\cdot b\',\\quad c^2 = a \\cdot c\',\\quad h^2 = b\' \\cdot c\'' },
      { name: 'Công thức nghiệm phương trình bậc 2', formula: 'ax^2 + bx + c = 0,\\quad \\Delta = b^2 - 4ac,\\quad x_{1,2} = \\dfrac{-b \\pm \\sqrt{\\Delta}}{2a}' },
      { name: 'Định lý Vi-ét', formula: 'x_1 + x_2 = -\\dfrac{b}{a},\\quad x_1 x_2 = \\dfrac{c}{a}' }
    ],
    '10': [
      { name: 'Định lý côsin', formula: 'a^2 = b^2 + c^2 - 2bc \\cos A' },
      { name: 'Định lý sin', formula: '\\dfrac{a}{\\sin A} = \\dfrac{b}{\\sin B} = \\dfrac{c}{\\sin C} = 2R' },
      { name: 'Công thức Heron', formula: 'S = \\sqrt{p(p-a)(p-b)(p-c)},\\quad p = \\dfrac{a+b+c}{2}' },
      { name: 'Tích vô hướng 2 vectơ', formula: '\\vec{a} \\cdot \\vec{b} = |\\vec{a}||\\vec{b}| \\cos(\\vec{a},\\vec{b})' }
    ],
    '11': [
      { name: 'Công thức lượng giác cơ bản', formula: '\\sin^2 x + \\cos^2 x = 1,\\quad 1 + \\tan^2 x = \\dfrac{1}{\\cos^2 x}' },
      { name: 'Cấp số cộng', formula: 'u_n = u_1 + (n-1)d,\\quad S_n = \\dfrac{n(u_1 + u_n)}{2}' },
      { name: 'Cấp số nhân', formula: 'u_n = u_1 \\cdot q^{n-1},\\quad S_n = \\dfrac{u_1(1-q^n)}{1-q}' },
      { name: 'Đạo hàm hàm đa thức', formula: '(x^n)\' = n x^{n-1},\\quad (\\sqrt{x})\' = \\dfrac{1}{2\\sqrt{x}}' }
    ],
    '12': [
      { name: 'Bảng nguyên hàm cơ bản', formula: '\\int x^n dx = \\dfrac{x^{n+1}}{n+1} + C,\\quad \\int \\dfrac{1}{x} dx = \\ln|x| + C' },
      { name: 'Tích phân từng phần', formula: '\\int_a^b u\\,dv = [u\\cdot v]_a^b - \\int_a^b v\\,du' },
      { name: 'Phương trình mặt phẳng (Oxyz)', formula: 'Ax + By + Cz + D = 0' },
      { name: 'Khoảng cách từ điểm tới mặt phẳng', formula: 'd(M, (P)) = \\dfrac{|Ax_0 + By_0 + Cz_0 + D|}{\\sqrt{A^2 + B^2 + C^2}}' }
    ]
  },
  vatly: {
    '10': [
      { name: 'Chuyển động thẳng biến đổi đều', formula: 'v = v_0 + at,\\quad s = v_0 t + \\dfrac{1}{2}at^2,\\quad v^2 - v_0^2 = 2as' },
      { name: 'Định luật II Newton', formula: '\\vec{F} = m\\vec{a}' },
      { name: 'Động năng & Thế năng trọng trường', formula: 'W_d = \\dfrac{1}{2}mv^2,\\quad W_t = mgz' }
    ],
    '11': [
      { name: 'Định luật Coulomb', formula: 'F = k \\dfrac{|q_1 q_2|}{\\varepsilon r^2}' },
      { name: 'Định luật Ohm cho toàn mạch', formula: 'I = \\dfrac{\\mathcal{E}}{R_N + r}' },
      { name: 'Lực từ tác dụng lên đoạn dây dẫn', formula: 'F = B I l \\sin\\alpha' }
    ],
    '12': [
      { name: 'Dao động điều hòa', formula: 'x = A \\cos(\\omega t + \\varphi),\\quad v = -\\omega A \\sin(\\omega t + \\varphi),\\quad a = -\\omega^2 x' },
      { name: 'Con lắc lò xo', formula: '\\omega = \\sqrt{\\dfrac{k}{m}},\\quad T = 2\\pi \\sqrt{\\dfrac{m}{k}}' },
      { name: 'Sóng cơ', formula: '\\lambda = v T = \\dfrac{v}{f}' },
      { name: 'Mạch RLC nối tiếp', formula: 'Z = \\sqrt{R^2 + (Z_L - Z_C)^2},\\quad I = \\dfrac{U}{Z}' }
    ]
  },
  hoahoc: {
    '10': [
      { name: 'Số mol & Khối lượng', formula: 'n = \\dfrac{m}{M},\\quad V = n \\times 24.79\\text{ (đkc)}' },
      { name: 'Nồng độ mol & Phần trăm', formula: 'C_M = \\dfrac{n}{V},\\quad C\\% = \\dfrac{m_{ct}}{m_{dd}} \\times 100\\%' }
    ],
    '11': [
      { name: 'pH dung dịch', formula: '\\text{pH} = -\\log[H^+],\\quad [H^+][OH^-] = 10^{-14}' },
      { name: 'Hằng số cân bằng', formula: 'aA + bB \\rightleftharpoons cC + dD \\implies K_c = \\dfrac{[C]^c [D]^d}{[A]^a [B]^b}' }
    ],
    '12': [
      { name: 'Phản ứng xà phòng hóa', formula: '(RCOO)_3C_3H_5 + 3NaOH \\xrightarrow{t^\\circ} 3RCOONa + C_3H_5(OH)_3' },
      { name: 'Thế điện cực & Suất điện động', formula: 'E^\\circ_{\\text{pin}} = E^\\circ_{\\text{catot}} - E^\\circ_{\\text{anot}}' }
    ]
  }
};
