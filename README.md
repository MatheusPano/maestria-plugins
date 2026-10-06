# maestria-plugins

Os plugins da Maestria, fora do app. Cada pasta é um plugin: um
`maestria-plugin.json` e, quando precisa de lógica, um processo node que fala o
protocolo da Maestria (JSON-RPC por stdin/stdout). Pra escrever um novo, o passo a
passo está em `docs/criando-um-plugin.md`, no repositório da maestria, e a
referência completa em `docs/plugins.md`.

| plugin | o que faz | teclas |
|---|---|---|
| `relatorio-do-dia` | os commits, o trabalho sem commit e as sessões do dia, contados pelo `claude -p` como uma daily. Escolhe o dia; de um dia passado usa os commits e as conversas arquivadas. A aba da lateral é a mesma tela do ⇧⌘R: o calendário, os botões e o último relatório, com o selo no ícone enquanto escreve. | ⇧⌘R |
| `catppuccin` | os temas Catppuccin Mocha, Macchiato e Latte (Aparência → "de plugins"). Só declarações, nenhum processo. | — |
| `flutter` | uma central de debug por projeto, quantas quiser abertas (o ícone do Flutter no rodapé pergunta em qual). Cada uma como a do VS Code: configurações do `.vscode/launch.json`, aparelho (e um botão que abre um emulador android ou o simulador do iOS e já o escolhe quando ele liga), barra de debug (continuar/pausar, step over/into/out, hot reload, hot restart, parar, DevTools), debug console com filtro, pilha quando pausa, hot reload ao salvar. E o DevTools numa janela da Maestria, conectado sozinho no app que roda: **Desempenho** (os frames em barras de build e raster contra o orçamento da tela, o jank, os mais lentos, e os interruptores do app — performance overlay, debug paint, repaint rainbow, imagens grandes demais, animações lentas), **CPU** (grave uns segundos e veja as funções por tempo próprio e total, só do seu código ou tudo; o clique abre no editor), **Memória** (o heap a cada segundo com as coletas, os objetos por classe, e uma marca pra ver o que cresceu — o vazamento) e **Rede** (os pedidos HTTP do `dart:io`, com cabeçalhos, corpo e copiar como curl). O DevTools completo segue a um clique, no navegador. Na aba da lateral, os worktrees de um app ficam embaixo dele, com o nome da branch, numa seta que abre e fecha (precisa da Maestria com `blocks: 2`; numa de antes, eles aparecem soltos como "app · worktree"). | ⇧⌘D abre · ⌥⌘T DevTools · F5 inicia/continua · ⇧F5 para · ⌥⌘R hot reload · ⇧⌘F5 hot restart · F6 pausa · F10/F11/⇧F11 step |
| `ssh` | um gerenciador de SSH como o Termius: salve hosts (endereço, usuário, porta, chave, opções) e um clique abre um terminal já conectado. Os hosts se organizam em grupos, cada um numa seção da lista que abre e fecha com um clique (fechada, ela diz quantos hosts de lá estão conectados): o ícone de pasta cria, renomeia e apaga grupos, e o botão direito num host o move de grupo. Os `Host` do `~/.ssh/config` aparecem também. O ícone do SSH na faixa é uma **tela própria**, como o cofre do Termius: os grupos em cartões e os hosts embaixo, numa grade que ganha colunas com a largura (a bolinha verde no canto do quadrado é conectado; a vermelha, caído). Clicar num grupo entra nele, com a trilha "Hosts › grupo" de volta; clicar num host conecta, e o terminal abre ao lado da grade, na mesma tela, com a lista do SSH na lateral. O lápis e o botão direito de cada cartão editam, movem, duplicam, copiam o comando e apagam, e o formulário de um host (novo, editar, duplicar) abre num modal do tamanho dos campos, com o novo grupo ali mesmo pelo seletor; o nome de um grupo (novo ou renomeado) é só um campo no topo da janela, enter e pronto. Precisa da Maestria com `contributes.screen` e os widgets (`rfw: 1`); numa de antes, a janela é a lista de sempre. O ícone de servidor no rodapé abre a lista; o seletor rápido conecta digitando o nome. | ⌥⌘S abre a lista · ⇧⌘S conecta pelo seletor |
| `git` | o controle de código do VS Code numa janela: a branch e quanto ela está à frente/atrás do remoto, as mudanças separadas em preparadas e não preparadas (clique num arquivo e o diff colorido abre ao lado; preparar, descartar e abrir no editor ficam na própria linha, com o mouse em cima), commit com mensagem sugerida pelo `claude -p`, fetch, pull, push/publicar, trocar e criar branch e os últimos commits. O ícone do git no rodapé pergunta qual repositório abrir. Atualiza sozinho enquanto está aberto. | ⇧⌘G abre o repositório do painel em foco |
| `docker` | os containers como no OrbStack, na aba da lateral: os projetos do compose numa linha com a seta que abre e fecha, o cubo colorido de cada imagem com a bolinha verde ou vermelha, e link, parar/subir e lixeira sempre à vista; "Parados" separa o fim da lista. Clicar num container abre a janela dele com as abas Info, Stats (CPU, memória, rede e disco ao vivo), Logs (as cores ANSI do app, o ERROR em vermelho) e Terminal (um shell de verdade dentro do container). Clicar num projeto abre os logs de todos juntos, em ordem de hora, com o serviço na cor dele. Imagens, volumes e disco numa janela à parte. Precisa da Maestria com a lista do OrbStack (`blocks: 2`); numa mais antiga, a aba volta pras seções que abrem e fecham e avisa pra atualizar. | ⌥⌘C abre a janela |
| `wiboor` | as tarefas do Wiboor num quadro Kanban, pela API pública: não iniciadas, em andamento, pausadas e finalizadas (dos últimos dias), cada cartão com o tipo, o número, a prioridade (a listra do lado), quem pediu (as iniciais), o prazo (em vermelho quando venceu), a barra do checklist, os comentários e os anexos, e os botões de iniciar, pausar e finalizar. **Arrastar** um cartão pra outra coluna inicia, pausa ou finaliza a tarefa: as colunas que aceitam acendem enquanto ele está no ar, o cartão muda na hora e volta se o Wiboor recusar — os botões do cartão também (finalizar só pergunta quando o checklist tem item aberto). O prazo fica vermelho quando venceu e amarelo hoje e amanhã ("em 3 dias" na semana). Embaixo do título, de quem é o quadro fica à vista (minhas · que pedi · outra pessoa · um espaço), e as pílulas dos números (vencidas, pra hoje ou amanhã, prioridade 8+, com o claude) filtram o quadro num clique. Precisa da Maestria com o `Draggable` e o `DropTarget` (`rfw: 2`); numa de antes, o quadro é o mesmo, sem arrastar. Cada pessoa arruma o quadro do seu jeito, e fica guardado pra ela (pelo usuário da chave do Wiboor): arrastar a coluna (pelo cabeçalho ou por qualquer canto fora dos cartões) a leva inteira, com os primeiros cartões, pra outro lugar, e o "…" de cada coluna a move, recolhe numa faixa estreita, troca a ordenação (prioridade, prazo, mais recentes, mais antigas) ou a esconde; a engrenagem abre o **personalizar o quadro**, com a ordem e a visibilidade das colunas, a largura delas, o que aparece no cartão e o voltar ao padrão. O filtro (o ícone de funil) troca de quem é o quadro — as que você executa, as que você pediu, as de outra pessoa ou as de um espaço inteiro — e a escolha fica guardada. Clicar num cartão abre a tarefa num **modal** por cima do quadro (numa Maestria com `modal: 1`; o "abrir como painel" do topo dele a põe na grade, e a opção "abrir a tarefa num modal" desligada abre direto como painel), com o título inteiro, o prazo, a prioridade e as datas em destaque, quem faz e quem pediu com a bolinha de cada um, o espaço e a branch (com o copiar), a descrição (com as imagens na linha, como no Wiboor), os anexos (as imagens em miniatura e a lista com abrir, baixar pro Downloads e copiar o link), o checklist pra marcar e acrescentar, os comentários e um campo pra comentar. Os anexos são o que está na descrição e nos comentários — a API pública não tem anexo à parte —, e o cartão diz quantos são. O botão do terminal em cada cartão é **trabalhar nesta tarefa**: pergunta o repositório, cria (ou reaproveita) a worktree como a Maestria faz (`.claude/worktrees/TASK-123`, branch `feature/TASK#123` ou `hotfix/BUG#123`), abre o claude lá com a tarefa no prompt (as imagens dos anexos já baixadas, pra ele ver os prints) e a inicia no Wiboor, e dá à branch a descrição do `git branch --edit-description` com o título da tarefa (a que o plugin `worktrees` mostra; uma que já existe fica). Daí em diante o cartão mostra o que a sessão está fazendo (pensando, permissão, pergunta…, na cor da lateral) e o mesmo botão vai pra ela; na janela da tarefa, o claude rascunha o comentário do que mudou na worktree, pra você revisar antes de mandar. O botão direito copia a branch e o link e abre no Wiboor. Dá pra criar tarefa — e, com o switch **criar a task no Wiboor** ligado no cartão de uma tarefa sugerida pelo claude na Maestria, qualquer saída do cartão (iniciar com worktree, iniciar localmente ou fazer aqui) abre antes o formulário já com o título e a descrição da sugestão; criada a tarefa, o plugin a inicia e devolve o número pra Maestria, que segue com a saída escolhida — a worktree com a branch da tarefa, a sessão nova ou o pedido na própria sessão — já com a tarefa no prompt (precisa da Maestria com `contributes.suggestions`) —, e a aba da lateral é a sua fila, com o selo de quantas estão em andamento. O ícone do Wiboor na faixa é uma **tela própria**: a fila na lateral e o quadro ocupando a área dos painéis, com cada tarefa abrindo ao lado dele; o ícone das sessões devolve a grade de terminais como estava, e "trabalhar nesta tarefa" leva direto pra sessão nova (precisa da Maestria com `contributes.screen`; numa de antes, o quadro abre entre as sessões). Tarefa de curso mostra o percentual e não muda de estado (quem fecha é a CEFIS). | ⌥⌘K abre o quadro |
| `worktrees` | todas as worktrees dos repositórios da lateral num lugar só, na aba da lateral: cada repositório numa linha que abre e fecha, e embaixo dele a pasta principal e as worktrees, a que mexeu por último em cima. Cada uma pela **descrição da branch** (a do `git branch --edit-description`, no `.git/config` do repositório: todas as worktrees enxergam e ela não sobe no push), com a branch, os commits à frente da base, os arquivos sem commit (o ícone fica amarelo) e a bolinha da sessão que está nela (verde com o claude, amarela esperando você). Uma branch com `TASK#123` ou `BUG#123` sem descrição ganha sozinha o título da tarefa no Wiboor. O lápis na linha descreve; o outro botão vai pra sessão dela ou abre o claude lá; o botão direito abre um terminal, o VS Code, copia a branch ou o caminho e remove a worktree (e a branch, se já estiver na base). Clicar abre a janela da worktree: os números, os commits que não estão na base, os arquivos sem commit (o clique abre no editor) e os mesmos botões. A que teve a pasta apagada aparece apagada, com o prune. | ⌥⌘W abre uma worktree pelo seletor · "descrever a branch do painel em foco" no menu de plugins |
| `pomodoro` | um pomodoro num painel pequeno que flutua por cima da janela: o anel da fase (vermelho no foco, verde na pausa curta, azul na longa), o tempo que falta, iniciar/pausar, pular e, no "…", os focos de hoje, trocar de fase, zerar o ciclo e esconder. **Arraste pra onde quiser**: perto de uma borda ele gruda nela (num canto, nas duas), e o lugar fica guardado. A aba da lateral tem o relógio grande, as fases num controle segmentado, as bolinhas do ciclo, os focos do dia e **os tempos**: foco, pausa curta, pausa longa e a cada quantos focos ela vem, no − e no +, com atalhos 25·5, 50·10 e 90·20; e os interruptores de começar a próxima fase sozinho, notificação, som, animação e o painel flutuante. No fim de cada fase, **uma animação grande por cima de tudo**: o anel da fase, confete e o que vem agora (hora do foco, hora da pausa, pausa longa), em todas as telas, mesmo com outro app na frente e sem roubar o teclado, no macOS e no Linux (no Linux, com um emoji no lugar do desenho); some sozinha em 4,5 s (o clique não fecha: pausa é pausa), e na seção **animação** da aba cada fase escolhe o desenho (12 opções) e a cor (8), que pinta também o anel do painel e o da aba, e o confete liga e desliga; "ver a animação" mostra a da fase escolhida. O tempo segue contando com o app fechado. Precisa da Maestria com o flutuante (`floats: 1`); numa de antes, o painel abre numa janela comum. | ⌥⌘O inicia/pausa · ⇧⌥⌘O mostra/esconde |
| `pomodoro_dart` | o mesmo `pomodoro`, em Dart: a lógica (`main.dart`, `maestria.dart`) compilada num binário nativo por plataforma em `build/`, com a mesma interface e a mesma animação. Quem usa não precisa do node; o `run.sh` escolhe o binário do sistema. Um teste pra comparar com o de node (~13 MB de memória contra ~44 MB). Recompile com `./build.sh` depois de mexer (`--all` gera também o Linux x64 e arm64). | as do `pomodoro` (com os dois instalados, o segundo fica sem tecla) |

## Instalar

Na Maestria: Configurações → plugins → **carregar pasta de desenvolvimento…** e
escolha a pasta do plugin. É um link: editou aqui, aperte **reiniciar** na linha
do plugin e vale.

Pela linha de comando dá no mesmo:

```sh
ln -s "$PWD/flutter" ~/.maestria/plugins/maestria.flutter
ln -s "$PWD/relatorio-do-dia" ~/.maestria/plugins/maestria.relatorio-do-dia
ln -s "$PWD/catppuccin" ~/.maestria/plugins/maestria.catppuccin
ln -s "$PWD/ssh" ~/.maestria/plugins/maestria.ssh
ln -s "$PWD/git" ~/.maestria/plugins/maestria.git
ln -s "$PWD/docker" ~/.maestria/plugins/maestria.docker
ln -s "$PWD/wiboor" ~/.maestria/plugins/maestria.wiboor
ln -s "$PWD/pomodoro" ~/.maestria/plugins/maestria.pomodoro
ln -s "$PWD/pomodoro_dart" ~/.maestria/plugins/maestria.pomodoro-dart
ln -s "$PWD/worktrees" ~/.maestria/plugins/maestria.worktrees
```

e depois **reler** na tela de plugins.

## Requisitos

- node 22 ou mais novo (o `flutter` usa o `WebSocket` global pro depurador). O `pomodoro_dart` não precisa: ele já vem compilado, e o Dart 3.8 ou mais novo só entra pra recompilar;
- `relatorio-do-dia`: o `claude` no PATH e `git`;
- `git`: o `git` do sistema, e o `claude` no PATH pra sugerir a mensagem de commit;
- `ssh`: o `ssh` do sistema (ou o programa que você puser nas configurações do plugin);
- `docker`: o cli do `docker` com o plugin do `compose` (OrbStack, colima ou Docker
  Desktop instalam os dois), ou o caminho que você puser nas configurações;
- `pomodoro`: pra animação do fim da fase, no macOS o `swiftc` (Command Line Tools do Xcode), compilada na primeira vez que o plugin sobe; no Linux o python3 com GTK 3 e a ponte dele com o cairo (`sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0`, que o Ubuntu e o Zorin já costumam trazer). Sem isso, fica a notificação e o som. O som no Linux é o `complete` do tema do freedesktop, pelo `pw-play`, `paplay` ou `canberra-gtk-play`;
- `wiboor`: a API key do Wiboor. O plugin a procura em `$WIBOOR_API_KEY` e no
  `~/.config/wiboor/config.json` (o mesmo arquivo das skills do Wiboor); sem ela, o quadro
  pede pra colar e grava lá, só pra você ler. O `git` do sistema pras worktrees, e o `claude` no
  PATH pro rascunho de comentário; o quadro em colunas pede a Maestria com a interface em widgets
  (`rfw`), e numa mais antiga ele vira abas, uma coluna por vez;
- `worktrees`: o `git` do sistema; pra descrição vir do Wiboor, a mesma chave do plugin `wiboor`
  (`$WIBOOR_API_KEY` ou `~/.config/wiboor/config.json`), e sem ela o resto funciona igual;
- `flutter`: o SDK do projeto — o `.fvm/flutter_sdk`, a versão do `.fvmrc` no
  cache do fvm, o `flutter` do PATH, ou o caminho que você digitar na central.

## Cada plugin tem uma cópia de `maestria.js`

É o cliente do protocolo (~100 linhas, sem dependências). Um plugin é uma pasta
que se instala sozinha, então ele não pode depender de um arquivo vizinho.

## Catálogo

Este repositório é o catálogo oficial da Maestria. Cada plugin sai numa release
própria, com a tag `<pasta>-v<versão>` (`wiboor-v1.9.0`, `git-v1.2.1`) e a pasta num
`.zip`, e o `catalog.json` com a última versão de todos fica na release `catalog`:

```
https://github.com/MatheusPano/maestria-plugins/releases/download/catalog/catalog.json
```

Quem usa instala só os plugins que quiser, e a Maestria atualiza cada um pela versão
dele.

**Publicar uma versão:** suba o `version` no `maestria-plugin.json` do plugin e mande
pra `main`. O workflow `release` vê que a versão ainda não tem tag, cria a release com
os commits que mexeram na pasta desde a anterior e refaz o catálogo. Sem subir a
versão, nada sai — quem já instalou não recebe a mudança. Pra conferir antes,
`node scripts/release.mjs --dry-run` gera os `.zip` e o `catalog.json` em `dist/` sem
publicar nada.

**Um plugin de outra pessoa:** há dois jeitos de ele entrar no catálogo.

- a pasta vem pra cá, por um PR, e passa a sair como os daqui;
- ou o código continua no repositório dela, e o PR só acrescenta uma linha no
  `external.json`:

  ```json
  { "plugins": [ { "git": "https://github.com/lucas/maestria-foo", "ref": "main" } ] }
  ```

  O repositório precisa do `maestria-plugin.json` na raiz (ou numa única pasta dentro
  dela), e o `id` não pode repetir o de outro plugin do catálogo. O catálogo relê os
  de fora todo dia; a versão é a do manifesto de lá.

Antes de entrar no catálogo, qualquer um deles dá pra instalar direto pela URL do
repositório, em Configurações → plugins → **instalar…**.
