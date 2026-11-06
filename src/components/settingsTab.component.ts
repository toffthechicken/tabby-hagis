import { Component } from '@angular/core'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'
import { HagisSitePermission, HagisTrustedCertificate } from '../config'
import { HAGIS_AUTHOR, HAGIS_INSTAGRAM, HAGIS_INSTAGRAM_URL, HagisWorkspace, ZOOM_PRESETS, countPanes, zoomPercent } from '../models'
import { HagisBrowserDataService, HagisBrowserSource } from '../services/browserData.service'
import { HAGIS_PERMISSION_LABELS, HagisWebService } from '../services/web.service'
import { HagisUpdateService } from '../services/update.service'
import { HagisWorkspaceService } from '../services/workspace.service'

/** 설정 → hagis */
@Component({
    template: `
<div class="hagis-settings">
    <h3>hagis <small class="text-muted">by tabby</small></h3>
    <p class="text-muted"><b style="color:#c6ff00">H</b>ub for <b style="color:#c6ff00">A</b>ll <b style="color:#c6ff00">G</b>ear, <b style="color:#c6ff00">I</b>n <b style="color:#c6ff00">S</b>ight — 네트워크 엔지니어용 통합 워크스페이스</p>
    <div class="hagis-credit">
        <span>made by <b>{{ author }}</b></span>
        <span class="hagis-credit-dot">·</span>
        <a href="#" (click)="openInstagram($event)"><i class="fab fa-instagram"></i> &#64;{{ instagram }}</a>
    </div>

    <h4>업데이트</h4>
    <div class="form-line">
        <div class="header">
            <div class="title">현재 버전 v{{ updates.current }}</div>
            <div class="description">{{ updates.status || '' }}</div>
        </div>
        <button class="btn btn-secondary" (click)="updates.checkNow()" [disabled]="updates.busy">지금 확인</button>
        <button class="btn btn-primary ms-2" *ngIf="updates.latest" (click)="updates.installLatest()" [disabled]="updates.busy">v{{ updates.latest.version }} 로 업데이트</button>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">자동 확인</div>
            <div class="description">GitHub 에 새 릴리스가 있는지 하루 한 번 확인합니다. 보내는 정보는 없고 GitHub 에는 IP 주소만 보입니다. 설치는 SHA-256 을 확인한 뒤 플러그인 파일만 바꾸며, 적용은 Tabby 를 다시 시작할 때입니다.</div>
        </div>
        <select class="form-control" style="width: 240px" [(ngModel)]="config.store.hagis.update.mode" (ngModelChange)="config.save()">
            <option value="ask">새 버전이 있으면 물어보기 (기본)</option>
            <option value="auto">자동으로 설치 (재시작은 직접)</option>
            <option value="off">확인하지 않음</option>
        </select>
    </div>

    <h4>화면</h4>
    <div class="form-line">
        <div class="header">
            <div class="title">패널 글자 크기 컨트롤</div>
            <div class="description">터미널 패널 우측 상단에 마우스를 올리면 A− / A+ / XS·S·M·L / 최대화 버튼을 표시합니다</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.paneControls" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">컴팩트 모드</div>
            <div class="description">탭 바·터미널 여백을 줄이고 모든 터미널 글자를 작게 해 한 화면에 더 많은 장비를 배치합니다</div>
        </div>
        <toggle [ngModel]="workspaces.compactMode" (ngModelChange)="workspaces.setCompactMode($event)"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">컴팩트 모드 글자 크기</div>
        </div>
        <select class="form-select" [(ngModel)]="config.store.hagis.compactZoom" (ngModelChange)="config.save()">
            <option *ngFor="let z of zoomOptions" [ngValue]="z">{{ percent(z) }}%</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">컴팩트 모드 여백</div>
            <div class="description">Tabby 기본값은 1.0 입니다</div>
        </div>
        <input type="range" class="form-range" min="0.1" max="1" step="0.05"
            [(ngModel)]="config.store.hagis.compactSpaciness" (ngModelChange)="config.save()">
        <span class="ms-2">{{ config.store.hagis.compactSpaciness }}</span>
    </div>

    <div class="form-line">
        <div class="header">
            <div class="title">패널 네임태그</div>
            <div class="description">분할 화면 각 패널 좌측 상단의 형광 이름표 — 드래그: 패널 이동 · 우클릭/더블클릭: 이름 변경</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.paneTags" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">모서리 크기 조절 핸들</div>
            <div class="description">가로·세로 경계가 만나는 모서리를 끌어 두 방향을 한 번에 조절 (더블클릭: 균등 분할)</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.cornerHandles" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">패널 경계선</div>
            <div class="description">분할된 패널 사이에 선을 그려 구분하기 쉽게 합니다. 색과 굵기를 직접 고를 수 있습니다.</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.paneBorders.enabled" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line" *ngIf="config.store.hagis.paneBorders.enabled">
        <div class="header">
            <div class="title">경계선 색 · 굵기</div>
            <div class="hagis-swatches">
                <button type="button" class="hagis-swatch" *ngFor="let c of borderColors" [style.background]="c.value" [title]="c.label" (click)="setBorderColor(c.value)"></button>
            </div>
        </div>
        <input type="color" class="form-control form-control-color hagis-color-input" [ngModel]="config.store.hagis.paneBorders.color" (ngModelChange)="setBorderColor($event)" title="직접 고르기">
        <select class="form-control ms-2" style="width: 90px" [(ngModel)]="config.store.hagis.paneBorders.width" (ngModelChange)="config.save()">
            <option [ngValue]="1">1px</option>
            <option [ngValue]="2">2px</option>
            <option [ngValue]="3">3px</option>
            <option [ngValue]="4">4px</option>
            <option [ngValue]="6">6px</option>
        </select>
    </div>
    <div class="form-line" *ngIf="config.store.hagis.paneBorders.enabled">
        <div class="header">
            <div class="title">경계선 진하기</div>
            <div class="description">낮을수록 은은합니다. 마우스를 올리면 선이 또렷해집니다 (크기 조절 가능 표시).</div>
        </div>
        <input type="range" class="form-control" style="width: 220px" min="20" max="100" step="5" [(ngModel)]="config.store.hagis.paneBorders.alpha" (ngModelChange)="config.save()">
        <span class="ms-2" style="min-width: 40px">{{ config.store.hagis.paneBorders.alpha }}%</span>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">독 (화면 옆 실행 막대)</div>
            <div class="description">자주 쓰는 프로그램·프로필·워크스페이스·웹 주소 아이콘. 탐색기에서 프로그램을 끌어다 놓으면 추가, 우클릭: 편집</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.dock.enabled" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line" *ngIf="config.store.hagis.dock.enabled">
        <div class="header">
            <div class="title">독 위치 · 확대 효과</div>
        </div>
        <select class="form-control" style="width: 110px" [(ngModel)]="config.store.hagis.dock.side" (ngModelChange)="config.save()">
            <option value="left">왼쪽</option>
            <option value="right">오른쪽</option>
        </select>
        <toggle class="ms-3" [(ngModel)]="config.store.hagis.dock.magnify" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line" *ngIf="config.store.hagis.dock.enabled">
        <div class="header">
            <div class="title">독 표시 방식</div>
            <div class="description">자동 숨기기: 평소에는 가장자리에 얇은 띠만 남고, 마우스를 대면 독이 화면 위로 나옵니다 (macOS 독처럼)</div>
        </div>
        <select class="form-control" style="width: 220px" [(ngModel)]="config.store.hagis.dock.autoHide" (ngModelChange)="config.save()">
            <option [ngValue]="false">항상 표시 (기본)</option>
            <option [ngValue]="true">마우스를 대면 표시 (자동 숨기기)</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">웹 미리보기 갱신 주기</div>
            <div class="description">메인 무대의 웹 미리보기는 실제 화면을 멈춰 두고(CPU 절약) 이 주기마다 캡처를 새로 찍습니다. 클릭해 메인으로 올리면 실시간 화면입니다.</div>
        </div>
        <select class="form-control" style="width: 120px" [(ngModel)]="config.store.hagis.preview.refreshSeconds" (ngModelChange)="config.save()">
            <option [ngValue]="3">3초</option>
            <option [ngValue]="5">5초</option>
            <option [ngValue]="10">10초</option>
            <option [ngValue]="30">30초</option>
            <option [ngValue]="60">1분</option>
        </select>
    </div>

    <h4 class="mt-4">터미널 이어가기</h4>
    <p class="text-muted small">
        hagis를 종료하면 터미널 안의 프로그램도 함께 끝납니다. 다시 열 때(재시작 복원·워크스페이스 열기) 같은 작업 폴더에서
        아래 규칙의 명령을 자동 실행해 이전 작업을 이어갑니다. 패널마다 네임태그 우클릭 → <b>시작 명령 지정</b>으로 직접 정할 수도 있습니다.
    </p>
    <div class="form-line">
        <div class="header">
            <div class="title">실행 중이던 AI CLI 자동 이어가기</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.resume.enabled" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="mb-3">
        <label class="form-label small">규칙 — 한 줄에 하나: <code>프로세스 이름 = 다시 실행할 명령</code></label>
        <textarea class="form-control hagis-rules" [(ngModel)]="config.store.hagis.resume.rules" (blur)="config.save()" spellcheck="false"></textarea>
    </div>

    <h4 class="mt-4">고객사 워크스페이스 <small class="text-muted">{{ workspaces.workspaces.length }}개</small></h4>
    <div class="d-flex gap-2 mb-2 flex-wrap">
        <input class="form-control hagis-filter" [(ngModel)]="filter" placeholder="검색">
        <button class="btn btn-secondary" (click)="exportAll()"><i class="fas fa-copy"></i> JSON 복사 (내보내기)</button>
        <button class="btn btn-secondary" (click)="showImport = !showImport"><i class="fas fa-file-import"></i> 가져오기</button>
    </div>
    <div *ngIf="showImport" class="mb-3">
        <textarea class="form-control hagis-import" [(ngModel)]="importText" placeholder="내보낸 JSON을 붙여넣으세요"></textarea>
        <button class="btn btn-primary mt-2" [disabled]="!importText.trim()" (click)="importAll()">가져오기</button>
    </div>

    <div *ngFor="let group of workspaces.groupedWorkspaces(filter)" class="mb-3">
        <div class="hagis-group-title"><i class="fas fa-building"></i> {{ group.customer }}</div>
        <div class="list-group">
            <div class="list-group-item hagis-ws" *ngFor="let ws of group.items">
                <hagis-layout-preview class="hagis-ws-preview" [node]="ws.layout"></hagis-layout-preview>
                <div class="hagis-ws-fields" *ngIf="editingId === ws.id; else view">
                    <input class="form-control form-control-sm" [(ngModel)]="edit.customer" placeholder="고객사">
                    <input class="form-control form-control-sm" [(ngModel)]="edit.name" placeholder="이름">
                    <input class="form-control form-control-sm" [(ngModel)]="edit.description" placeholder="메모">
                </div>
                <ng-template #view>
                    <div class="hagis-ws-fields">
                        <div class="fw-bold">{{ ws.name }}</div>
                        <div class="small text-muted">{{ ws.description || '' }} · {{ count(ws) }}개 패널 · 수정 {{ ws.updatedAt | date:'yyyy-MM-dd HH:mm' }}</div>
                    </div>
                </ng-template>
                <div class="hagis-ws-actions">
                    <ng-container *ngIf="editingId === ws.id; else actions">
                        <button class="btn btn-sm btn-primary" (click)="saveEdit(ws)">확인</button>
                        <button class="btn btn-sm btn-secondary" (click)="editingId = null">취소</button>
                    </ng-container>
                    <ng-template #actions>
                        <button class="btn btn-sm btn-primary" (click)="workspaces.openWorkspace(ws)" title="열기"><i class="fas fa-play"></i></button>
                        <button class="btn btn-sm btn-secondary" (click)="startEdit(ws)" title="이름·고객사 수정"><i class="fas fa-pen"></i></button>
                        <button class="btn btn-sm btn-secondary" (click)="workspaces.duplicateWorkspace(ws)" title="복제"><i class="fas fa-clone"></i></button>
                        <button class="btn btn-sm btn-danger" (click)="remove(ws)" title="삭제"><i class="fas fa-trash"></i></button>
                    </ng-template>
                </div>
            </div>
        </div>
    </div>

    <h4 class="mt-4">웹 GUI 패널</h4>
    <div class="form-line">
        <div class="header">
            <div class="title">새 탭으로 열리는 링크</div>
            <div class="description">웹 페이지가 링크를 새 탭(target=_blank)으로 열려 할 때: 옆에 새 패널(이름표가 하나 더 생김)로 열거나 이 패널에서 엽니다. 로그인·인쇄 같은 진짜 팝업은 항상 팝업 창으로 뜹니다.</div>
        </div>
        <select class="form-control" style="width: 220px" [(ngModel)]="config.store.hagis.web.newTabLinks" (ngModelChange)="config.save()">
            <option value="pane">옆에 새 패널로 열기 (기본)</option>
            <option value="same">이 패널에서 열기</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">스크립트가 여는 창</div>
            <div class="description">버튼을 눌렀을 때 페이지의 코드(window.open)가 여는 창입니다. 열어 준 창과 정보를 주고받는 사이트(원격 콘솔·결제·인증 창 등)는 진짜 창이거나 "패널로 열고 연결"이어야 동작합니다. "패널로 열고 연결"은 Hagis가 두 페이지 사이의 메시지(postMessage)를 대신 전달합니다(JSON으로 표현되는 값만 전달). 열어 준 창의 내용을 직접 만지는 사이트가 패널에서 안 되면 "진짜 창"으로 바꾸세요. 단순히 패널로만 바꾸면 그런 사이트는 비어 보일 수 있습니다. 이미 열려 있는 페이지는 새로 고쳐야 적용됩니다.</div>
        </div>
        <select class="form-control" style="width: 260px" [(ngModel)]="config.store.hagis.web.scriptOpen" (ngModelChange)="config.save()">
            <option value="relay">옆에 새 패널로 열고 연결 (기본)</option>
            <option value="window">진짜 창으로 열기</option>
            <option value="pane">옆에 새 패널로만 열기</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">주소창에 검색어 입력</div>
            <div class="description">주소가 아닌 글(예: 방화벽 개요)을 입력하면 이 검색 엔진으로 검색합니다. IP 주소·도메인(naver.com)·localhost·호스트:포트(fw01:8443)는 그대로 주소로 열립니다. 점이 없는 한 단어(예: fw01)는 검색어로 보므로 장비 이름은 주소(fw01/)나 IP로 입력하세요.</div>
        </div>
        <select class="form-control" style="width: 260px" [(ngModel)]="config.store.hagis.web.searchEngine" (ngModelChange)="config.save()">
            <option value="google">Google (기본)</option>
            <option value="naver">네이버</option>
            <option value="bing">Bing</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="off">검색하지 않음 (항상 주소로 열기)</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">웹 화면 브라우저 단축키</div>
            <div class="description">웹 화면을 클릭한 상태에서 Ctrl+F(찾기), Ctrl+P(인쇄), F5·Ctrl+R(새로고침), Alt+←/→(뒤로·앞으로), Ctrl+L(주소창), Ctrl+±/0(확대), F12(개발자 도구)를 씁니다. Ctrl+F·Ctrl+P 같은 키를 자체 기능으로 쓰는 웹 앱(문서 편집기 등)에서 충돌하면 끄세요. 우클릭 메뉴는 항상 사용할 수 있습니다.</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.web.shortcuts" (ngModelChange)="config.save(); web.syncKeyFlag()"></toggle>
    </div>
    <p class="text-muted small">
        웹 패널은 Tabby와 분리된 세션(persist:hagis-web)에서 Node.js 권한 없이 실행됩니다.
        인증서 검증은 끄지 않으며, 자체 서명 인증서는 아래 목록에 있는 호스트·지문만 허용합니다.
    </p>
    <div class="list-group mb-2">
        <div class="list-group-item d-flex align-items-center gap-2" *ngFor="let cert of web.trustedCertificates">
            <div class="flex-grow-1 hagis-cert">
                <div class="fw-bold">{{ cert.host }}</div>
                <div class="small text-muted">{{ cert.subject }} · {{ cert.addedAt | date:'yyyy-MM-dd' }}</div>
                <code class="small">{{ cert.fingerprint }}</code>
            </div>
            <button class="btn btn-sm btn-danger" (click)="untrust(cert)"><i class="fas fa-trash"></i></button>
        </div>
        <div class="list-group-item text-muted small" *ngIf="!web.trustedCertificates.length">신뢰한 인증서가 없습니다</div>
    </div>
    <p class="text-muted small mt-3">
        웹 사이트가 마이크·카메라·위치·알림을 쓰려 하면 패널에 허용 여부를 묻습니다. "허용"/"차단"을 고르면 이 사이트에 대해 기억하며, 아래에서 지우면 다음에 다시 묻습니다.
        화면 공유는 매번 공유할 화면을 직접 고릅니다.
    </p>
    <div class="list-group mb-2">
        <div class="list-group-item d-flex align-items-center gap-2" *ngFor="let p of web.sitePermissions">
            <div class="flex-grow-1">
                <span class="fw-bold">{{ p.origin }}</span>
                <span class="small"> — {{ permissionLabel(p.permission) }}: </span>
                <span class="small" [class.text-success]="p.allow" [class.text-danger]="!p.allow">{{ p.allow ? '허용' : '차단' }}</span>
            </div>
            <button class="btn btn-sm btn-danger" (click)="forgetPermission(p)" title="기억 지우기 (다음에 다시 묻습니다)"><i class="fas fa-trash"></i></button>
        </div>
        <div class="list-group-item text-muted small" *ngIf="!web.sitePermissions.length">기억해 둔 사이트 권한이 없습니다</div>
    </div>
    <button class="btn btn-secondary" (click)="clearWebData()"><i class="fas fa-broom"></i> 웹 패널 쿠키·캐시 삭제</button>

    <h4 class="mt-4">다운로드 · 문서 뷰어</h4>
    <p class="text-muted small">
        웹 패널에서 받은 파일은 패널 우측 상단의 둥근 다운로드 버튼에 진행률이 표시되고, 눌러서 열기·폴더 보기·취소를 할 수 있습니다.
        HWP·HWPX·Word(docx)·Excel(xlsx·xls·csv)·PowerPoint(pptx)·PDF·텍스트·그림은 <b>hagis 문서 뷰어</b>로 패널 안에서 바로 볼 수 있습니다
        (다운로드 목록의 문서 아이콘 · 파일을 탭 바/패널에 끌어다 놓기 · 명령 팔레트 "hagis: 문서 열기"). 구형 .doc·.ppt 와 암호가 걸린 문서는 열 수 없고, 실행 파일(.exe 등)은 앱에서 열지 않고 폴더에서 보기만 제공합니다.
    </p>
    <div class="form-line">
        <div class="header">
            <div class="title">받을 때마다 저장 위치 묻기</div>
            <div class="description">끄면 아래 폴더에 바로 저장합니다 (같은 이름이 있으면 "이름 (1)" 로 저장해 기존 파일을 덮어쓰지 않습니다).</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.download.askWhere" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line" *ngIf="!config.store.hagis.download.askWhere">
        <div class="header">
            <div class="title">저장 폴더</div>
            <div class="description">비워 두면 Windows 의 "다운로드" 폴더입니다.</div>
        </div>
        <input class="form-control" style="width: 340px" [(ngModel)]="config.store.hagis.download.folder" (blur)="config.save()" placeholder="예: D:\\Downloads" spellcheck="false">
    </div>

    <h4 class="mt-4">브라우저 연동 <small class="text-muted">주소창 자동완성 · Chrome/Edge 가져오기</small></h4>
    <p class="text-muted small">
        주소창에 입력하면 즐겨찾기와 방문 기록에서 후보를 보여 줍니다. Chrome·Edge·웨일·Brave 의 즐겨찾기와 방문 기록을 가져와 함께 쓸 수 있습니다.
        브라우저의 파일은 읽기만 하고(복사본을 읽음) 바꾸지 않으며, 가져온 내용은 이 PC의 hagis 설정 폴더(hagis-browser.json)에만 저장됩니다.
        <b>쿠키·비밀번호는 가져오지 않습니다</b> — Chrome/Edge(127 이후)가 암호화 키를 브라우저 자신에게만 묶어 두어 다른 프로그램은 읽을 수 없습니다.
        로그인은 웹 패널에서 한 번 하면 hagis 안에 유지됩니다.
    </p>
    <div class="form-line">
        <div class="header">
            <div class="title">주소창 자동완성</div>
            <div class="description">입력하는 동안 아래에 후보 목록을 띄웁니다 (↑↓ 선택 · Enter 이동 · Esc 닫기). 입력칸이 비어 있을 때 ↓ 를 누르면 자주 가는 곳이 나옵니다.</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.browser.suggest.enabled" (ngModelChange)="config.save()"></toggle>
    </div>
    <ng-container *ngIf="config.store.hagis.browser.suggest.enabled">
        <div class="form-line">
            <div class="header">
                <div class="title">후보에 포함할 것 · 개수</div>
            </div>
            <label class="me-3"><input type="checkbox" [(ngModel)]="config.store.hagis.browser.suggest.bookmarks" (ngModelChange)="config.save()"> 즐겨찾기</label>
            <label class="me-3"><input type="checkbox" [(ngModel)]="config.store.hagis.browser.suggest.history" (ngModelChange)="config.save()"> 방문 기록</label>
            <select class="form-control" style="width: 90px" [(ngModel)]="config.store.hagis.browser.suggest.max" (ngModelChange)="config.save()">
                <option [ngValue]="5">5개</option>
                <option [ngValue]="8">8개</option>
                <option [ngValue]="10">10개</option>
                <option [ngValue]="12">12개</option>
            </select>
        </div>
    </ng-container>
    <div class="form-line">
        <div class="header">
            <div class="title">hagis 방문 기록 남기기</div>
            <div class="description">웹 패널에서 연 주소를 자동완성용으로 기억합니다. 아이디·비밀번호·토큰·세션 값이 든 주소와 검색 결과 화면은 남기지 않습니다. 지금 {{ browserData.ownCount }}개.</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.browser.recordHistory" (ngModelChange)="config.save()"></toggle>
        <button class="btn btn-secondary ms-3" (click)="clearOwnHistory()" [disabled]="!browserData.ownCount"><i class="fas fa-trash"></i> 지우기</button>
    </div>

    <div class="form-line">
        <div class="header">
            <div class="title">가져올 항목</div>
            <div class="description">방문 기록은 가장 최근 것부터 아래 개수까지만 가져옵니다.</div>
        </div>
        <label class="me-3"><input type="checkbox" [(ngModel)]="config.store.hagis.browser.importBookmarks" (ngModelChange)="config.save()"> 즐겨찾기</label>
        <label class="me-3"><input type="checkbox" [(ngModel)]="config.store.hagis.browser.importHistory" (ngModelChange)="config.save()"> 방문 기록</label>
        <select class="form-control" style="width: 110px" [(ngModel)]="config.store.hagis.browser.importHistoryLimit" (ngModelChange)="config.save()">
            <option [ngValue]="1000">1,000개</option>
            <option [ngValue]="5000">5,000개</option>
            <option [ngValue]="20000">20,000개</option>
            <option [ngValue]="50000">50,000개</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">시작할 때 자동으로 최신화</div>
            <div class="description">이미 가져온 브라우저는 hagis 를 켠 뒤 잠시 있다가 다시 읽어 최신으로 맞춥니다. 브라우저가 켜져 있어 파일이 잠겨 있으면 건너뜁니다.</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.browser.autoSync" (ngModelChange)="config.save()"></toggle>
    </div>

    <div class="d-flex align-items-center gap-2 mb-2">
        <b>이 PC에서 찾은 브라우저</b>
        <button class="btn btn-sm btn-secondary" (click)="scanBrowsers()"><i class="fas fa-sync-alt"></i> 다시 찾기</button>
    </div>
    <div class="list-group mb-2">
        <div class="list-group-item d-flex align-items-center gap-2" *ngFor="let src of browserData.sources">
            <div class="flex-grow-1 hagis-source">
                <div class="fw-bold">{{ src.browserLabel }} · {{ src.profileName }}</div>
                <div class="small text-muted" *ngIf="src.userName">{{ src.userName }}</div>
                <div class="small" *ngIf="browserData.importedStatus(src.key) as st">
                    마지막 가져오기 {{ st.at | date:'yyyy-MM-dd HH:mm' }} · 즐겨찾기 {{ st.bookmarks }}개 · 방문 기록 {{ st.history }}개
                </div>
                <div class="small" *ngIf="browserData.messages[src.key] as msg" [class.text-danger]="msg.error" [class.text-success]="!msg.error">{{ msg.text }}</div>
            </div>
            <button class="btn btn-sm btn-primary" (click)="importFrom(src)" [disabled]="browserData.busy.has(src.key)">
                <i class="fas" [class.fa-download]="!browserData.busy.has(src.key)" [class.fa-spinner]="browserData.busy.has(src.key)" [class.fa-spin]="browserData.busy.has(src.key)"></i>
                {{ browserData.importedStatus(src.key) ? '다시 가져오기' : '가져오기' }}
            </button>
            <button class="btn btn-sm btn-danger" *ngIf="browserData.importedStatus(src.key)" (click)="removeImported(src)" title="가져온 내용 지우기"><i class="fas fa-trash"></i></button>
        </div>
        <div class="list-group-item text-muted small" *ngIf="!browserData.sources.length">Chrome·Edge·웨일·Brave 를 찾지 못했습니다</div>
    </div>
</div>
`,
    styles: [`
.hagis-settings h4 { font-size: 16px; font-weight: 600; }
.hagis-filter { max-width: 240px; }
.hagis-import { min-height: 120px; font-family: monospace; font-size: 12px; }
.hagis-rules { min-height: 80px; font-family: monospace; font-size: 12px; }
.hagis-group-title { font-size: 12px; opacity: .75; margin-bottom: 4px; }
.hagis-ws { display: flex; align-items: center; gap: 12px; }
.hagis-ws-preview { width: 96px; height: 54px; flex: none !important; }
.hagis-ws-fields { flex: auto; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.hagis-ws-actions { flex: none; display: flex; gap: 4px; }
.hagis-cert code { word-break: break-all; }
.hagis-source { min-width: 0; }
.hagis-settings .form-line label, .hagis-settings .form-line .btn { white-space: nowrap; }
.hagis-swatches { display: flex; gap: 6px; margin-top: 4px; }
.hagis-swatch { width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); cursor: pointer; }
.hagis-swatch:hover { border-color: #fff; }
.hagis-color-input { width: 48px; height: 34px; padding: 2px; }
.hagis-credit {
    display: inline-flex; align-items: center; gap: 8px; margin: -4px 0 18px; padding: 4px 12px; border-radius: 999px;
    font-size: 12px; background: rgba(198, 255, 0, .08); border: 1px solid rgba(198, 255, 0, .35);
}
.hagis-credit b { color: #c6ff00; letter-spacing: .3px; }
.hagis-credit a { color: inherit; text-decoration: none; opacity: .85; }
.hagis-credit a:hover { opacity: 1; text-decoration: underline; }
.hagis-credit-dot { opacity: .4; }
`],
})
export class HagisSettingsTabComponent {
    filter = ''
    showImport = false
    importText = ''
    editingId: string|null = null
    edit = { name: '', customer: '', description: '' }
    zoomOptions = [-6, -5, -4, -3, -2, -1, ...ZOOM_PRESETS.filter(p => p.zoom >= 0).map(p => p.zoom)]
    author = HAGIS_AUTHOR
    borderColors = [
        { label: '형광 (기본)', value: '#c6ff00' },
        { label: '하늘', value: '#00f0ff' },
        { label: '흰색', value: '#ffffff' },
        { label: '회색', value: '#6b7280' },
        { label: '주황', value: '#ff9f1c' },
        { label: '분홍', value: '#ff4d9d' },
        { label: '빨강', value: '#ff5f5f' },
    ]
    instagram = HAGIS_INSTAGRAM

    constructor (
        public config: ConfigService,
        public workspaces: HagisWorkspaceService,
        public web: HagisWebService,
        public updates: HagisUpdateService,
        public browserData: HagisBrowserDataService,
        private platform: PlatformService,
        private notifications: NotificationsService,
    ) {
        this.browserData.refreshSources()
    }

    scanBrowsers (): void {
        const found = this.browserData.refreshSources()
        this.notifications.notice(`hagis: 브라우저 프로필 ${found.length}개를 찾았습니다`)
    }

    importFrom (source: HagisBrowserSource): Promise<void> {
        return this.browserData.importSource(source)
    }

    async removeImported (source: HagisBrowserSource): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `${source.browserLabel} · ${source.profileName} 에서 가져온 즐겨찾기·방문 기록을 hagis 에서 지울까요? (브라우저의 원본은 그대로입니다)`,
            buttons: ['지우기', '취소'],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response === 0) {
            this.browserData.removeImported(source.key)
        }
    }

    async clearOwnHistory (): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: 'hagis 웹 패널의 방문 기록을 모두 지울까요? (가져온 즐겨찾기·기록은 그대로입니다)',
            buttons: ['지우기', '취소'],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response === 0) {
            this.browserData.clearOwn()
        }
    }

    percent (z: number): number {
        return zoomPercent(z)
    }

    setBorderColor (color: string): void {
        if (/^#[0-9a-f]{6}$/i.test(color)) {
            this.config.store.hagis.paneBorders.color = color
            this.config.save()
        }
    }

    openInstagram (event: Event): void {
        event.preventDefault()
        this.platform.openExternal(HAGIS_INSTAGRAM_URL)
    }

    count (ws: HagisWorkspace): number {
        return countPanes(ws.layout)
    }

    startEdit (ws: HagisWorkspace): void {
        this.editingId = ws.id
        this.edit = { name: ws.name, customer: ws.customer ?? '', description: ws.description ?? '' }
    }

    async saveEdit (ws: HagisWorkspace): Promise<void> {
        if (!this.edit.name.trim()) {
            return
        }
        await this.workspaces.upsertWorkspace({
            ...ws,
            name: this.edit.name.trim(),
            customer: this.edit.customer.trim() || undefined,
            description: this.edit.description.trim() || undefined,
        })
        this.editingId = null
    }

    async remove (ws: HagisWorkspace): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `"${ws.name}" 워크스페이스를 삭제할까요?`,
            buttons: ['삭제', '취소'],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response === 0) {
            await this.workspaces.deleteWorkspace(ws.id)
        }
    }

    exportAll (): void {
        this.platform.setClipboard({ text: this.workspaces.exportWorkspaces() })
        this.notifications.notice('hagis: 워크스페이스 JSON을 클립보드에 복사했습니다')
    }

    async importAll (): Promise<void> {
        try {
            const count = await this.workspaces.importWorkspaces(this.importText)
            this.notifications.info(`hagis: 워크스페이스 ${count}개를 가져왔습니다`)
            this.importText = ''
            this.showImport = false
        } catch (e) {
            this.notifications.error('hagis: 가져오기 실패', String(e))
        }
    }

    async untrust (cert: HagisTrustedCertificate): Promise<void> {
        await this.web.untrust(cert)
    }

    permissionLabel (key: string): string {
        return HAGIS_PERMISSION_LABELS[key] ?? key
    }

    async forgetPermission (entry: HagisSitePermission): Promise<void> {
        await this.web.forgetPermission(entry)
    }

    async clearWebData (): Promise<void> {
        await this.web.clearBrowsingData()
        this.notifications.notice('hagis: 웹 패널 쿠키·캐시를 삭제했습니다')
    }
}
