import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { UsersService } from '../users/users.service';
import { LyricsService } from '../lyrics/lyrics.service';

describe('AdminService', () => {
  let service: AdminService;

  const mockUsersService = {
    findAll: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
  };

  const mockLyricsService = {
    findAll: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    findOneIncludingInactive: jest.fn(),
    restore: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: LyricsService, useValue: mockLyricsService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should list users through the users service', async () => {
    const users = [{ id: 'user-1' }];
    mockUsersService.findAll.mockResolvedValue(users);
    mockUsersService.count.mockResolvedValue(1);

    await expect(service.findAllUsers({})).resolves.toEqual({
      data: users,
      meta: { total: 1, limit: 20, offset: 0 },
    });
    expect(mockUsersService.findAll).toHaveBeenCalledWith(20, 0, undefined, undefined);
    expect(mockUsersService.count).toHaveBeenCalled();
  });

  it('should paginate users and report the correct meta.total', async () => {
    const users = [{ id: 'user-11' }];
    mockUsersService.findAll.mockResolvedValue(users);
    mockUsersService.count.mockResolvedValue(42);

    const result = await service.findAllUsers({
      limit: 10,
      offset: 10,
      sortBy: 'createdAt',
      sortOrder: 'ASC',
    });

    expect(mockUsersService.findAll).toHaveBeenCalledWith(
      10,
      10,
      'createdAt',
      'ASC',
    );
    expect(result).toEqual({
      data: users,
      meta: { total: 42, limit: 10, offset: 10 },
    });
  });

  it('should report the message returned when deleting a user', async () => {
    mockUsersService.remove.mockResolvedValue({ message: 'User deleted' });

    await expect(service.deleteUser('user-1')).resolves.toBe('User deleted');
    expect(mockUsersService.remove).toHaveBeenCalledWith('user-1');
  });

  it('should fall back to a default message when deletion returns none', async () => {
    mockUsersService.remove.mockResolvedValue({});

    await expect(service.deleteUser('user-1')).resolves.toBe(
      'User deleted successfully',
    );
  });

  it('should list lyrics through the lyrics service', async () => {
    const lyrics = [{ id: 1 }];
    mockLyricsService.findAll.mockResolvedValue(lyrics);
    mockLyricsService.count.mockResolvedValue(1);

    await expect(service.findAllLyrics({})).resolves.toEqual({
      data: lyrics,
      meta: { total: 1, limit: 20, offset: 0 },
    });
    expect(mockLyricsService.findAll).toHaveBeenCalledWith(
      20,
      0,
      undefined,
      undefined,
      undefined,
    );
    expect(mockLyricsService.count).toHaveBeenCalled();
  });

  it('should filter lyrics by status=inactive', async () => {
    const lyrics = [{ id: 2, isActive: false }];
    mockLyricsService.findAll.mockResolvedValue(lyrics);
    mockLyricsService.count.mockResolvedValue(1);

    const result = await service.findAllLyrics({ status: 'inactive' });

    expect(mockLyricsService.findAll).toHaveBeenCalledWith(
      20,
      0,
      undefined,
      undefined,
      false,
    );
    expect(result.data).toEqual(lyrics);
    expect(result.meta.total).toBe(1);
  });

  it('should not filter lyrics by active state when status=all', async () => {
    mockLyricsService.findAll.mockResolvedValue([]);
    mockLyricsService.count.mockResolvedValue(0);

    await service.findAllLyrics({ status: 'all' });

    expect(mockLyricsService.findAll).toHaveBeenCalledWith(
      20,
      0,
      undefined,
      undefined,
      undefined,
    );
  });

  it('should set createdBy on imported lyrics', async () => {
    const dto = { title: 'Song', content: 'Lyrics' };
    const admin = { id: 'admin-1' } as any;
    mockLyricsService.create.mockResolvedValue({ id: 1, ...dto });

    await service.importLyrics(dto as any, admin);

    expect(mockLyricsService.create).toHaveBeenCalledWith(dto, admin);
  });

  it('should pass the acting admin through on lyric updates', async () => {
    const dto = { title: 'Updated' };
    const admin = { id: 'admin-1' } as any;
    mockLyricsService.update.mockResolvedValue({ id: 1, ...dto });

    await service.updateLyric(1, dto as any, admin);

    expect(mockLyricsService.update).toHaveBeenCalledWith(1, dto, admin);
  });

  it('should delete lyrics by numeric id', async () => {
    mockLyricsService.remove.mockResolvedValue(undefined);

    await service.deleteLyric(7);

    expect(mockLyricsService.remove).toHaveBeenCalledWith(7);
  });

  it('should restore a soft-deleted lyric using findOneIncludingInactive', async () => {
    const inactive = { id: 5, isActive: false };
    const restored = { id: 5, isActive: true };
    mockLyricsService.findOneIncludingInactive.mockResolvedValue(inactive);
    mockLyricsService.restore.mockResolvedValue(restored);

    await expect(service.restoreLyric(5)).resolves.toEqual(restored);
    expect(mockLyricsService.findOneIncludingInactive).toHaveBeenCalledWith(5);
    expect(mockLyricsService.restore).toHaveBeenCalledWith(5);
  });

  it('should throw ConflictException when restoring an already active lyric', async () => {
    mockLyricsService.findOneIncludingInactive.mockResolvedValue({
      id: 5,
      isActive: true,
    });

    await expect(service.restoreLyric(5)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mockLyricsService.restore).not.toHaveBeenCalled();
  });
});
