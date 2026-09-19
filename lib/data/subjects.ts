export interface SubjectOption {
  id: string;
  name: string;
  icon: string;
}

export const SUBJECTS: SubjectOption[] = [
  { id: 'auto', name: 'Tự động nhận diện', icon: '✨' },
  { id: 'math', name: 'Toán học', icon: '📐' },
  { id: 'physics', name: 'Vật lý', icon: '⚛️' },
  { id: 'chemistry', name: 'Hóa học', icon: '🧪' },
  { id: 'biology', name: 'Sinh học', icon: '🧬' },
  { id: 'literature', name: 'Ngữ văn', icon: '📖' },
  { id: 'english', name: 'Tiếng Anh', icon: '🇬🇧' },
  { id: 'history', name: 'Lịch sử', icon: '🏛️' },
  { id: 'geography', name: 'Địa lý', icon: '🌍' },
  { id: 'computer-science', name: 'Tin học', icon: '💻' },
  { id: 'natural-science', name: 'Khoa học tự nhiên', icon: '🔬' },
  { id: 'economics-civics', name: 'Kinh tế / Công dân', icon: '⚖️' },
  { id: 'general', name: 'Môn học khác', icon: '📚' }
];

export const SUBJECT_MAP: Record<string, SubjectOption> = SUBJECTS.reduce(
  (map, s) => {
    map[s.id] = s;
    return map;
  },
  {} as Record<string, SubjectOption>
);

export function getSubjectInfo(id: string): SubjectOption {
  return SUBJECT_MAP[id] || SUBJECT_MAP.general;
}
