// Design Ref: §9.4 — Domain 계층. 외부 의존성이 전혀 없는 순수 데이터/조회 함수.
// 카테고리·단어는 더 이상 이 파일에 적지 않는다. 혼자 하기(word_connection_game.html)와
// 멀티플레이가 저장소에 하나뿐인 quiz-data/word-categories.json 을 함께 읽으므로,
// 두 모드가 다른 단어로 노는 일이 구조적으로 없어졌다 (예전엔 이 파일에 사전을 그대로
// 복사해 두고 "저쪽을 고치면 이 파일도 고친다"는 주석으로 버텼다).
// Plan SC: 모든 글자수(2~5)에서 최소 1개 카테고리로 게임 시작 가능해야 함.

const fs = require('fs');
const path = require('path');

const DATA_FILE_NAME = 'word-categories.json';

/* ---------- JSON 파일을 어디서 찾을 것인가 ----------
 * server.js 의 LOCAL_RUN 판단과 같은 이유로 두 자리만 확인한다 (임의로 여러 경로를
 * 뒤지지 않는다).
 *   1) 저장소 루트의 quiz-data/ — 로컬에서 그냥 node 로 켠 경우와 Render(저장소를
 *      통째로 체크아웃해 `npm start` 로 실행 — Dockerfile 을 쓰지 않는다)가 여기 해당한다.
 *   2) server/Dockerfile 이 `COPY quiz-data ./public/quiz-data` 로 넣어 준 자리 —
 *      Vultr 등 Docker 로 띄운 경우에만 해당한다.
 * __dirname 은 이 파일이 실제로 있는 위치를 가리키므로(server/src/domain, 컨테이너
 * 안에서도 src/domain), 실행 위치(cwd)와 무관하게 항상 같은 두 후보를 계산한다.
 */
const CANDIDATE_PATHS = [
    path.join(__dirname, '..', '..', '..', 'quiz-data', DATA_FILE_NAME),
    path.join(__dirname, '..', '..', 'public', 'quiz-data', DATA_FILE_NAME)
];

function resolveDataPath() {
    const found = CANDIDATE_PATHS.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error(
            `[dictionary] ${DATA_FILE_NAME} 을(를) 찾지 못했습니다. 다음 위치를 확인했습니다:\n`
            + CANDIDATE_PATHS.map((candidate) => `  - ${candidate}`).join('\n')
        );
    }
    return found;
}

/**
 * quiz-data/word-categories.json 을 읽어 { 카테고리: [단어...] } 객체로 만든다.
 * 서버 시작 시(모듈이 처음 require 될 때) 단 한 번만 부르고, 그 뒤로는 다시 읽지 않는다.
 * 형식이 잘못됐으면 여기서 예외를 던져 서버가 빈 사전으로 조용히 뜨는 일을 막는다 —
 * require() 중에 던진 예외는 server.js 까지 그대로 올라가 프로세스를 종료시킨다.
 */
function loadDictionary() {
    const filePath = resolveDataPath();

    let raw;
    try {
        // 메모장이 UTF-8 로 저장하며 붙이는 BOM 도 걸러 읽는다 (quiz-data 의 다른 파일과 같은 관례).
        raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    } catch (err) {
        throw new Error(`[dictionary] ${filePath} 을(를) 읽지 못했습니다: ${err.message}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`[dictionary] ${filePath} 의 JSON 형식이 올바르지 않습니다: ${err.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`[dictionary] ${filePath} 의 최상위 값이 { 카테고리: [단어...] } 객체가 아닙니다.`);
    }

    const names = Object.keys(parsed);
    if (names.length === 0) {
        throw new Error(`[dictionary] ${filePath} 에 카테고리가 하나도 없습니다.`);
    }

    names.forEach((name) => {
        if (typeof name !== 'string' || name.trim() === '') {
            throw new Error(`[dictionary] ${filePath} 에 비어 있는 카테고리 이름이 있습니다.`);
        }
        const words = parsed[name];
        if (!Array.isArray(words)) {
            throw new Error(`[dictionary] ${filePath} 의 '${name}' 값이 배열이 아닙니다.`);
        }
        // 한 라운드에 정답 단어 2개가 필요하므로, 카테고리 하나가 game을 진행하려면 최소 2개는 있어야 한다.
        if (words.length < 2) {
            throw new Error(`[dictionary] ${filePath} 의 '${name}' 카테고리에 단어가 2개 미만입니다.`);
        }
        words.forEach((word) => {
            if (typeof word !== 'string' || word.trim() === '') {
                throw new Error(`[dictionary] ${filePath} 의 '${name}' 카테고리에 빈 값이거나 문자열이 아닌 단어가 있습니다.`);
            }
        });
    });

    return parsed;
}

const dictionary = loadDictionary();

/** 보드의 빈칸을 채울 때 사용하는 흔한 한글 음절 모음 */
const FILLER_CHARS = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후기니디리미비시이지치키티피히강건경고과관광구국군권금기길김남대도동명문미민박방배백번부북분산서석선설성세수숙순승시신심안양연영오용우원유윤은이인임장전정제조종주지진찬창채천철최추춘태하한해현호홍화환회효훈흥희";

function getCategories() {
    return Object.keys(dictionary);
}

function getWordsByLength(category, length) {
    return (dictionary[category] || []).filter((word) => word.length === length);
}

/** 해당 글자수의 단어를 2개 이상 가진 카테고리만 반환 (한 라운드에 정답 단어 2개가 필요하므로) */
function getValidCategories(length) {
    return getCategories().filter((category) => getWordsByLength(category, length).length >= 2);
}

/** 카테고리의 단어 전체 (글자 수를 가리지 않는다) */
function getWords(category) {
    return (dictionary[category] || []).slice();
}

/**
 * 블록 안에 넣을 수 있는 단어만 남긴 목록.
 * 목표 글자 수 설정을 없앤 뒤로는 "몇 글자짜리를 낼 수 있는가"가 블록 개수에 달려 있어서,
 * 라운드를 만들 때도 정답을 판정할 때도 이 기준을 함께 쓴다.
 */
function getWordsFittingBoard(category, blockCount) {
    return getWords(category).filter((word) => word.length * 2 <= blockCount);
}

/** 한 보드에 정답 단어 2개를 넣을 수 있는 카테고리만 반환 */
function getCategoriesFittingBoard(blockCount) {
    return getCategories().filter((category) => getWordsFittingBoard(category, blockCount).length >= 2);
}

/** 이 카테고리에 있는 단어인가 (정답 판정용) */
function hasWord(category, word) {
    return getWords(category).includes(word);
}

function randomFillerChar() {
    return FILLER_CHARS.charAt(Math.floor(Math.random() * FILLER_CHARS.length));
}

module.exports = {
    dictionary,
    getCategories,
    getWords,
    getWordsByLength,
    getValidCategories,
    getWordsFittingBoard,
    getCategoriesFittingBoard,
    hasWord,
    randomFillerChar
};
