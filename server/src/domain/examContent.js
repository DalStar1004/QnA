// Design Ref: §3 — Domain 계층. 모드 3(산업재산권 문제)의 문제 목록을 다룬다.
//
// 혼자 하기(word_connection_game.html)는 브라우저가 이 파일을 fetch 해서 읽지만,
// 멀티플레이에서는 **서버가 읽는다.** 이유는 스무고개와 같다 (Design §1.2).
//   1. 정답이 서버에만 있어야 한다. 클라이언트가 문제 파일을 통째로 받으면 정답도 함께 간다.
//   2. 모두가 같은 문제를 같은 순서로 봐야 공정하다.
//
// 문제 파일 형식은 혼자 하기와 완전히 같다 — '문제:' 와 '답:' 두 줄이 한 쌍이고,
// 정답이 여러 개면 쉼표로 나눈다. 파일 하나를 두 모드가 함께 쓰므로 파서도 같게 맞춰 두었다.

const fs = require('fs');
const path = require('path');

// 저장소 루트의 quiz-data/ 를 본다. 도커 이미지에서는 public/quiz-data 로 들어오므로 둘 다 찾는다.
const CANDIDATE_DIRS = [
    path.join(__dirname, '..', '..', '..', 'quiz-data'),   // 저장소에서 그대로 실행할 때
    path.join(__dirname, '..', '..', 'public', 'quiz-data') // 도커 이미지 안
];
const EXAM_FILE_NAME = '산업재산권_문제.txt';

/**
 * 문제 파일을 읽어 문제 목록으로 만든다.
 * 혼자 하기의 ExamBank.parse 와 같은 규칙이다.
 *   - 콜론 앞뒤 공백이 들쭉날쭉해도 읽는다.
 *   - 정답 안의 공백은 지운다 (블록으로 만들 글자라서).
 *   - 메모장이 붙이는 BOM 을 벗겨 낸다. 그대로 두면 첫 문제를 통째로 놓친다.
 *
 * @param {string} text
 * @returns {{question: string, answers: string[]}[]}
 */
function parseExamText(text) {
    const list = [];
    let current = null;
    String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        const questionMatch = line.match(/^문제\s*[:：]\s*(.+)$/);
        if (questionMatch) {
            current = { question: questionMatch[1].trim(), answers: [] };
            return;
        }
        const answerMatch = line.match(/^답\s*[:：]\s*(.+)$/);
        if (answerMatch && current) {
            current.answers = answerMatch[1]
                .split(',')
                .map((part) => part.replace(/\s+/g, ''))
                .filter(Boolean);
            if (current.answers.length) list.push(current);
            current = null;
        }
    });
    return list;
}

/** 문제 파일이 실제로 있는 경로. 못 찾으면 null. */
function findExamFile() {
    for (const dir of CANDIDATE_DIRS) {
        const candidate = path.join(dir, EXAM_FILE_NAME);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

// 파일은 한 번만 읽고 기억해 둔다. 문제를 고친 뒤에는 서버를 다시 켜야 반영된다
// (게임 도중에 문제가 바뀌면 같은 방의 참가자끼리 다른 문제를 보게 된다).
let cached = null;

/**
 * 낼 수 있는 문제 전부. 파일이 없거나 읽지 못하면 빈 배열을 돌려준다.
 * 그때는 ExamService 가 시작을 막고 방장에게 이유를 알려 준다.
 */
function getExamQuestions() {
    if (cached) return cached;
    const file = findExamFile();
    if (!file) {
        console.warn(`[exam] 문제 파일을 찾지 못했습니다 (${EXAM_FILE_NAME}). 모드 3을 쓸 수 없습니다.`);
        cached = [];
        return cached;
    }
    try {
        cached = parseExamText(fs.readFileSync(file, 'utf8'));
        console.log(`[exam] 문제 ${cached.length}개를 읽었습니다 — ${file}`);
    } catch (error) {
        console.warn(`[exam] 문제 파일을 읽지 못했습니다: ${error.message}`);
        cached = [];
    }
    return cached;
}

/**
 * 보드에 깔 글자를 만든다.
 * 정답이 여러 개인 문제는 **모든 정답의 글자**가 보드에 있어야 어느 것으로든 만들 수 있다.
 * 설정한 블록 개수가 그보다 적으면 여유 두 칸을 더해 자동으로 늘린다 —
 * 정답을 만들 수 없는 판이 나오는 것을 막기 위해서다(혼자 하기와 같은 규칙).
 */
function buildExamBoard(answers, blockCount) {
    const chars = answers.join('').split('');
    const target = Math.max(blockCount, chars.length + 2);
    while (chars.length < target) {
        chars.push(randomFillerChar());
    }
    return shuffled(chars);
}

// 채움 글자. 흔한 한글 낱자를 써서 정답 글자가 도드라져 보이지 않게 한다.
const FILLER = '가나다라마바사아자차카타파하고구기너노누니더도두미보부비서소수시어오우이저조주지';

function randomFillerChar() {
    return FILLER.charAt(Math.floor(Math.random() * FILLER.length));
}

function shuffled(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

module.exports = {
    EXAM_FILE_NAME,
    parseExamText,
    getExamQuestions,
    buildExamBoard
};
