'use strict';

/* =====================================================================
   Danh mục công thức cốt lõi theo chương trình học các cấp (VN).
   Dữ liệu tĩnh, chạy hoàn toàn trên trình duyệt — không gọi API.
   Cấu trúc: FORMULA_LIBRARY[subjectKey][gradeKey] = [{name, formula, note?}, ...]
   - formula dùng cú pháp LaTeX (không cần dấu $, panel sẽ tự bọc khi hiển thị)
   - gradeKey: "1".."12" hoặc "dai-hoc"
   ===================================================================== */

window.FORMULA_SUBJECTS = [
  { key: 'toan', label: 'Toán học', icon: '📐' },
  { key: 'vatly', label: 'Vật lý', icon: '⚛️' },
  { key: 'hoahoc', label: 'Hóa học', icon: '🧪' }
];

window.FORMULA_LIBRARY = {
  toan: {
    '1': [
      { name: 'Phép cộng, phép trừ trong phạm vi 100', formula: 'a + b = c \\quad,\\quad c - b = a' },
      { name: 'So sánh số', formula: 'a > b,\\ a < b,\\ a = b' }
    ],
    '2': [
      { name: 'Bảng nhân, bảng chia (2–5)', formula: 'a \\times b = c \\quad,\\quad c \\div b = a' },
      { name: 'Chu vi hình tứ giác', formula: 'P = a+b+c+d' }
    ],
    '3': [
      { name: 'Chu vi hình chữ nhật', formula: 'P = (a+b)\\times 2' },
      { name: 'Chu vi hình vuông', formula: 'P = a \\times 4' },
      { name: 'Diện tích hình chữ nhật', formula: 'S = a \\times b' },
      { name: 'Diện tích hình vuông', formula: 'S = a \\times a' }
    ],
    '4': [
      { name: 'Diện tích hình bình hành', formula: 'S = a \\times h' },
      { name: 'Diện tích hình thoi', formula: 'S = \\dfrac{d_1 \\times d_2}{2}' },
      { name: 'Trung bình cộng', formula: '\\overline{x} = \\dfrac{a_1+a_2+\\cdots+a_n}{n}' },
      { name: 'Tính phân số của một số', formula: '\\dfrac{a}{b} \\text{ của } N = N \\times \\dfrac{a}{b}' }
    ],
    '5': [
      { name: 'Diện tích hình tam giác', formula: 'S = \\dfrac{a \\times h}{2}' },
      { name: 'Diện tích hình thang', formula: 'S = \\dfrac{(a+b)\\times h}{2}' },
      { name: 'Chu vi & diện tích hình tròn', formula: 'C = d\\times 3.14 = 2\\times r\\times 3.14,\\quad S = r^2 \\times 3.14' },
      { name: 'Thể tích hình hộp chữ nhật', formula: 'V = a \\times b \\times c' },
      { name: 'Thể tích hình lập phương', formula: 'V = a^3' },
      { name: 'Tỉ số phần trăm', formula: '\\%A/B = \\dfrac{A}{B}\\times 100\\%' }
    ],
    '6': [
      { name: 'Lũy thừa với số mũ tự nhiên', formula: 'a^n = \\underbrace{a\\times a\\times\\cdots\\times a}_{n\\ \\text{thừa số}}' },
      { name: 'Ước chung lớn nhất & Bội chung nhỏ nhất', formula: '\\text{ƯCLN}(a,b)\\times\\text{BCNN}(a,b)=a\\times b' },
      { name: 'Cộng, trừ phân số', formula: '\\dfrac{a}{b}+\\dfrac{c}{d}=\\dfrac{ad+bc}{bd}' },
      { name: 'Nhân, chia phân số', formula: '\\dfrac{a}{b}\\times\\dfrac{c}{d}=\\dfrac{ac}{bd},\\quad \\dfrac{a}{b}\\div\\dfrac{c}{d}=\\dfrac{a}{b}\\times\\dfrac{d}{c}' }
    ],
    '7': [
      { name: 'Lũy thừa của một tích, một thương', formula: '(a\\cdot b)^n=a^n b^n,\\quad \\left(\\dfrac{a}{b}\\right)^n=\\dfrac{a^n}{b^n}' },
      { name: 'Tỉ lệ thức', formula: '\\dfrac{a}{b}=\\dfrac{c}{d} \\iff a\\cdot d = b\\cdot c' },
      { name: 'Tính chất dãy tỉ số bằng nhau', formula: '\\dfrac{a}{b}=\\dfrac{c}{d}=\\dfrac{a+c}{b+d}=\\dfrac{a-c}{b-d}' },
      { name: 'Định lý Pytago', formula: 'a^2+b^2=c^2 \\ \\text{(c là cạnh huyền)}' },
      { name: 'Tổng ba góc trong tam giác', formula: '\\hat{A}+\\hat{B}+\\hat{C}=180^\\circ' }
    ],
    '8': [
      { name: 'Bảy hằng đẳng thức đáng nhớ', formula: '(a\\pm b)^2=a^2\\pm 2ab+b^2,\\quad a^2-b^2=(a-b)(a+b)' },
      { name: 'Lập phương của tổng/hiệu', formula: '(a\\pm b)^3=a^3\\pm 3a^2b+3ab^2\\pm b^3' },
      { name: 'Tổng, hiệu hai lập phương', formula: 'a^3+b^3=(a+b)(a^2-ab+b^2),\\ \\ a^3-b^3=(a-b)(a^2+ab+b^2)' },
      { name: 'Định lý Thales', formula: '\\dfrac{AB}{AC}=\\dfrac{AD}{AE}\\ \\text{(khi } DE\\parallel BC\\text{)}' },
      { name: 'Diện tích đa giác đều & hình thang', formula: 'S_{\\text{thang}}=\\dfrac{(a+b)h}{2}' }
    ],
    '9': [
      { name: 'Công thức nghiệm phương trình bậc hai', formula: 'x=\\dfrac{-b\\pm\\sqrt{b^2-4ac}}{2a},\\quad \\Delta=b^2-4ac' },
      { name: 'Định lý Vi-ét', formula: 'x_1+x_2=-\\dfrac{b}{a},\\quad x_1 x_2=\\dfrac{c}{a}' },
      { name: 'Căn bậc hai', formula: '\\sqrt{a^2}=|a|,\\quad \\sqrt{ab}=\\sqrt{a}\\cdot\\sqrt{b}\\ (a,b\\ge0)' },
      { name: 'Hệ thức lượng trong tam giác vuông', formula: 'h^2=b\\prime c\\prime,\\quad \\dfrac{1}{h^2}=\\dfrac{1}{b^2}+\\dfrac{1}{c^2}' },
      { name: 'Tỉ số lượng giác góc nhọn', formula: '\\sin=\\dfrac{\\text{đối}}{\\text{huyền}},\\ \\cos=\\dfrac{\\text{kề}}{\\text{huyền}},\\ \\tan=\\dfrac{\\text{đối}}{\\text{kề}}' },
      { name: 'Độ dài đường tròn & diện tích hình tròn', formula: 'C=2\\pi r,\\quad S=\\pi r^2' }
    ],
    '10': [
      { name: 'Định lý cos trong tam giác', formula: 'a^2=b^2+c^2-2bc\\cos A' },
      { name: 'Định lý sin trong tam giác', formula: '\\dfrac{a}{\\sin A}=\\dfrac{b}{\\sin B}=\\dfrac{c}{\\sin C}=2R' },
      { name: 'Diện tích tam giác', formula: 'S=\\dfrac12 ab\\sin C=\\sqrt{p(p-a)(p-b)(p-c)}' },
      { name: 'Phương trình đường thẳng', formula: 'y=ax+b \\quad \\text{hoặc} \\quad Ax+By+C=0' },
      { name: 'Bất đẳng thức Cô-si (2 số)', formula: '\\dfrac{a+b}{2}\\ge\\sqrt{ab}\\ (a,b\\ge0)' }
    ],
    '11': [
      { name: 'Công thức lượng giác cơ bản', formula: '\\sin^2 x+\\cos^2 x=1,\\quad \\tan x=\\dfrac{\\sin x}{\\cos x}' },
      { name: 'Công thức cộng', formula: '\\sin(a\\pm b)=\\sin a\\cos b\\pm\\cos a\\sin b' },
      { name: 'Công thức nhân đôi', formula: '\\sin2a=2\\sin a\\cos a,\\quad \\cos2a=2\\cos^2a-1' },
      { name: 'Cấp số cộng', formula: 'u_n=u_1+(n-1)d,\\quad S_n=\\dfrac{n(u_1+u_n)}{2}' },
      { name: 'Cấp số nhân', formula: 'u_n=u_1\\cdot q^{n-1},\\quad S_n=u_1\\dfrac{1-q^n}{1-q}\\ (q\\ne1)' },
      { name: 'Giới hạn cơ bản', formula: '\\lim_{x\\to0}\\dfrac{\\sin x}{x}=1' }
    ],
    '12': [
      { name: 'Đạo hàm cơ bản', formula: "(x^n)'=nx^{n-1},\\ (\\sin x)'=\\cos x,\\ (e^x)'=e^x" },
      { name: 'Nguyên hàm cơ bản', formula: '\\int x^n dx=\\dfrac{x^{n+1}}{n+1}+C\\ (n\\ne-1)' },
      { name: 'Tích phân & diện tích hình phẳng', formula: 'S=\\int_a^b |f(x)-g(x)|\\,dx' },
      { name: 'Thể tích khối tròn xoay', formula: 'V=\\pi\\int_a^b [f(x)]^2\\,dx' },
      { name: 'Số phức', formula: 'z=a+bi,\\quad |z|=\\sqrt{a^2+b^2}' },
      { name: 'Thể tích khối chóp, khối lăng trụ', formula: 'V_{\\text{chóp}}=\\dfrac13 S_{\\text{đáy}}\\cdot h,\\quad V_{\\text{lăng trụ}}=S_{\\text{đáy}}\\cdot h' },
      { name: 'Mặt cầu, khối cầu', formula: 'S=4\\pi r^2,\\quad V=\\dfrac43\\pi r^3' }
    ],
    'dai-hoc': [
      { name: 'Đạo hàm hàm hợp (chain rule)', formula: "\\dfrac{d}{dx}f(g(x)) = f'(g(x))\\cdot g'(x)" },
      { name: 'Tích phân từng phần', formula: '\\int u\\,dv = uv-\\int v\\,du' },
      { name: 'Khai triển Taylor', formula: 'f(x)=\\sum_{n=0}^{\\infty}\\dfrac{f^{(n)}(a)}{n!}(x-a)^n' },
      { name: 'Định thức ma trận 2x2', formula: '\\det\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}=ad-bc' },
      { name: 'Ma trận nghịch đảo', formula: 'A^{-1}=\\dfrac{1}{\\det A}\\,\\text{adj}(A)' },
      { name: 'Phương trình vi phân tuyến tính cấp 1', formula: "y' + p(x)y = q(x)" }
    ]
  },

  vatly: {
    '6': [
      { name: 'Khối lượng riêng', formula: 'D=\\dfrac{m}{V}' },
      { name: 'Trọng lượng riêng', formula: 'd=\\dfrac{P}{V}=10D' },
      { name: 'Vận tốc trung bình', formula: 'v=\\dfrac{s}{t}' }
    ],
    '7': [
      { name: 'Định luật phản xạ ánh sáng', formula: '\\hat{i}=\\hat{r}' },
      { name: 'Cường độ dòng điện & hiệu điện thế (mạch nối tiếp)', formula: 'I=I_1=I_2,\\quad U=U_1+U_2' },
      { name: 'Mạch song song', formula: 'I=I_1+I_2,\\quad U=U_1=U_2' }
    ],
    '8': [
      { name: 'Công thức tính áp suất', formula: 'p=\\dfrac{F}{S}' },
      { name: 'Áp suất chất lỏng', formula: 'p=d\\cdot h' },
      { name: 'Công cơ học', formula: 'A=F\\cdot s' },
      { name: 'Công suất', formula: 'P=\\dfrac{A}{t}' },
      { name: 'Định luật Ác-si-mét', formula: 'F_A=d\\cdot V' }
    ],
    '9': [
      { name: 'Định luật Ôm', formula: 'I=\\dfrac{U}{R}' },
      { name: 'Điện trở dây dẫn', formula: 'R=\\rho\\dfrac{l}{S}' },
      { name: 'Đoạn mạch nối tiếp / song song', formula: 'R_{nt}=R_1+R_2,\\quad \\dfrac{1}{R_{ss}}=\\dfrac{1}{R_1}+\\dfrac{1}{R_2}' },
      { name: 'Công suất điện & điện năng tiêu thụ', formula: 'P=U\\cdot I,\\quad A=P\\cdot t' },
      { name: 'Định luật Jun – Len-xơ', formula: 'Q=I^2Rt' }
    ],
    '10': [
      { name: 'Chuyển động thẳng biến đổi đều', formula: 'v=v_0+at,\\quad s=v_0t+\\dfrac12at^2' },
      { name: 'Công thức liên hệ v, a, s', formula: 'v^2-v_0^2=2as' },
      { name: 'Định luật II Newton', formula: 'F=ma' },
      { name: 'Định luật vạn vật hấp dẫn', formula: 'F=G\\dfrac{m_1m_2}{r^2}' },
      { name: 'Động lượng & định luật bảo toàn động lượng', formula: 'p=mv,\\quad \\sum \\vec p_{trước}=\\sum \\vec p_{sau}' },
      { name: 'Động năng, thế năng, cơ năng', formula: 'W_đ=\\dfrac12mv^2,\\ W_t=mgh,\\ W=W_đ+W_t' }
    ],
    '11': [
      { name: 'Định luật Cu-lông', formula: 'F=k\\dfrac{|q_1q_2|}{\\varepsilon r^2}' },
      { name: 'Cường độ điện trường', formula: 'E=\\dfrac{F}{q}=k\\dfrac{|Q|}{\\varepsilon r^2}' },
      { name: 'Tụ điện', formula: 'C=\\dfrac{Q}{U}' },
      { name: 'Suất điện động & định luật Ôm toàn mạch', formula: '\\mathcal{E}=I(R+r)' },
      { name: 'Cảm ứng từ dòng điện thẳng dài', formula: 'B=2\\times10^{-7}\\dfrac{I}{r}' },
      { name: 'Dao động điều hòa', formula: 'x=A\\cos(\\omega t+\\varphi)' }
    ],
    '12': [
      { name: 'Chu kỳ con lắc lò xo', formula: 'T=2\\pi\\sqrt{\\dfrac{m}{k}}' },
      { name: 'Chu kỳ con lắc đơn', formula: 'T=2\\pi\\sqrt{\\dfrac{l}{g}}' },
      { name: 'Bước sóng', formula: '\\lambda = vT = \\dfrac{v}{f}' },
      { name: 'Cường độ dòng điện xoay chiều', formula: 'i=I_0\\cos(\\omega t+\\varphi)' },
      { name: 'Công thức tính công suất mạch RLC', formula: 'P=UI\\cos\\varphi' },
      { name: 'Thuyết lượng tử ánh sáng (Einstein)', formula: '\\varepsilon = hf = \\dfrac{hc}{\\lambda}' },
      { name: 'Hệ thức Anh-xtanh về năng lượng', formula: 'E=mc^2' },
      { name: 'Độ hụt khối & năng lượng liên kết hạt nhân', formula: '\\Delta m = Zm_p+(A-Z)m_n-m_X,\\quad W_{lk}=\\Delta m\\cdot c^2' }
    ],
    'dai-hoc': [
      { name: 'Phương trình sóng cơ', formula: 'u(x,t)=A\\cos(\\omega t-kx)' },
      { name: 'Định luật Gauss (điện trường)', formula: '\\oint \\vec E\\cdot d\\vec A=\\dfrac{Q_{enc}}{\\varepsilon_0}' },
      { name: 'Phương trình Schrödinger (dừng)', formula: '-\\dfrac{\\hbar^2}{2m}\\nabla^2\\psi+V\\psi=E\\psi' }
    ]
  },

  hoahoc: {
    '8': [
      { name: 'Công thức tính số mol', formula: 'n=\\dfrac{m}{M}=\\dfrac{V}{22.4}\\ (\\text{đktc})' },
      { name: 'Nồng độ phần trăm', formula: 'C\\% = \\dfrac{m_{ct}}{m_{dd}}\\times100\\%' },
      { name: 'Định luật bảo toàn khối lượng', formula: 'm_{sản\\ phẩm}=m_{chất\\ tham\\ gia}' }
    ],
    '9': [
      { name: 'Nồng độ mol', formula: 'C_M=\\dfrac{n}{V}\\ (\\text{mol/lít})' },
      { name: 'Pha loãng / pha trộn dung dịch', formula: 'C_1V_1=C_2V_2' },
      { name: 'Độ tan', formula: 'S=\\dfrac{m_{ct}}{m_{H_2O}}\\times100' }
    ],
    '10': [
      { name: 'Cấu hình electron nguyên tử', formula: '1s^2\\,2s^2\\,2p^6\\,3s^2\\,3p^6\\ldots' },
      { name: 'Số hiệu nguyên tử & khối lượng nguyên tử', formula: 'A=Z+N' },
      { name: 'Độ âm điện & liên kết hóa học', formula: '\\Delta\\chi = |\\chi_A-\\chi_B|' },
      { name: 'Hiệu suất phản ứng', formula: 'H\\%=\\dfrac{\\text{lượng thực tế}}{\\text{lượng lý thuyết}}\\times100\\%' }
    ],
    '11': [
      { name: 'Hằng số cân bằng', formula: 'K_C=\\dfrac{[C]^c[D]^d}{[A]^a[B]^b}' },
      { name: 'pH của dung dịch', formula: 'pH=-\\log[H^+]' },
      { name: 'Công thức tính số nguyên tử C trung bình (hữu cơ)', formula: '\\overline{n}=\\dfrac{\\sum n_i \\cdot mol_i}{\\sum mol_i}' }
    ],
    '12': [
      { name: 'Suất điện động pin điện hóa', formula: 'E_{pin}=E_{cathode}-E_{anode}' },
      { name: 'Định luật Faraday (điện phân)', formula: 'm=\\dfrac{AIt}{nF}' },
      { name: 'Độ rượu', formula: '\\text{Độ rượu}=\\dfrac{V_{rượu\\ nguyên\\ chất}}{V_{dd}}\\times100' },
      { name: 'Phản ứng este hóa (bảo toàn khối lượng)', formula: 'm_{axit}+m_{ancol}=m_{este}+m_{H_2O}' }
    ],
    'dai-hoc': [
      { name: 'Phương trình khí lý tưởng', formula: 'pV=nRT' },
      { name: 'Phương trình Arrhenius', formula: 'k=Ae^{-E_a/RT}' },
      { name: 'Phương trình Nernst', formula: 'E=E^{\\circ}-\\dfrac{RT}{nF}\\ln Q' }
    ]
  }
};

/* Nhãn hiển thị cho khối/lớp */
window.GRADE_LABELS = {
  '1': 'Lớp 1', '2': 'Lớp 2', '3': 'Lớp 3', '4': 'Lớp 4', '5': 'Lớp 5',
  '6': 'Lớp 6', '7': 'Lớp 7', '8': 'Lớp 8', '9': 'Lớp 9',
  '10': 'Lớp 10', '11': 'Lớp 11', '12': 'Lớp 12',
  'dai-hoc': 'Đại học'
};

window.SCHOOL_LEVELS = {
  'tieu-hoc': { label: 'Tiểu học', grades: ['1', '2', '3', '4', '5'] },
  'thcs': { label: 'THCS', grades: ['6', '7', '8', '9'] },
  'thpt': { label: 'THPT', grades: ['10', '11', '12'] },
  'dai-hoc': { label: 'Đại học', grades: ['dai-hoc'] }
};
